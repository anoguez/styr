import { OFFLINE_DEFAULTS, SNAPSHOT_CHANNELS, WRITE_CHANNELS } from './channels.js'
import type { HostEntry, RemoteRegistry, RemoteTarget, Stub } from './registry.js'

/**
 * Sending a call to a remote workspace's server. Only a live board takes writes; otherwise a read
 * answers with the last snapshot kept for it (or an empty board), and a write is refused with the
 * reason. Nothing is ever queued.
 */

/** A call refused because the remote board is not live. Its message is shown as is. */
export class RemoteUnavailable extends Error {
  override readonly name = 'RemoteUnavailable'
}

export function disabledMessage(workspace: Stub): string {
  return `${workspace.name} is a remote workspace, and remote workspaces are off. Turn them on in Settings → Experimental.`
}

/** The last answers to reads, by stub, channel and arguments. */
export class Snapshots {
  private readonly values = new Map<string, unknown>()

  private static key(stubId: string, channel: string, args: unknown[]): string {
    return `${stubId}\0${channel}\0${JSON.stringify(args)}`
  }

  has(stubId: string, channel: string, args: unknown[] = []): boolean {
    return this.values.has(Snapshots.key(stubId, channel, args))
  }

  get(stubId: string, channel: string, args: unknown[] = []): unknown {
    return this.values.get(Snapshots.key(stubId, channel, args))
  }

  set(stubId: string, channel: string, args: unknown[], value: unknown): void {
    this.values.set(Snapshots.key(stubId, channel, args), value)
  }

  /** Forgets every stub not in `keep` (a removed workspace). */
  retain(keep: ReadonlyMap<string, unknown>): void {
    for (const key of [...this.values.keys()]) {
      if (!keep.has(key.slice(0, key.indexOf('\0')))) this.values.delete(key)
    }
  }
}

export interface Forwarder {
  /** A call for a remote workspace's board. */
  forward(target: RemoteTarget, channel: string, args: unknown[]): Promise<unknown>
  /** A call for a session on a host, whatever workspace is open. */
  forwardToHost(entry: HostEntry, channel: string, args: unknown[]): Promise<unknown>
}

export function createForwarder(
  registry: RemoteRegistry,
  snapshots: Snapshots,
  /** Notes the sessions a result carries (`terminals.ts`). */
  recordSessions: (entry: HostEntry, channel: string, result: unknown) => void
): Forwarder {
  function unavailableMessage(target: RemoteTarget): string {
    const { workspace, link, host } = target
    const error = host.errors.get(link.workspaceId)
    if (error) return `${workspace.name} cannot be shown: ${error}`
    const state = host.conn.state()
    if (state.status === 'incompatible') {
      return `${state.lastError ?? `${link.host} runs an incompatible server.`} Upgrade it from Settings → Remote hosts.`
    }
    if (!host.conn.connected) {
      return `${workspace.name} is offline while Styr reconnects to ${link.host}. Nothing was changed or queued.`
    }
    const elsewhere = registry.elsewhereName(host, link.workspaceId)
    if (elsewhere) return `${link.host} is showing “${elsewhere}”. Switch back to make changes.`
    return `${workspace.name} is still loading from ${link.host}. Try again in a moment.`
  }

  async function forward(target: RemoteTarget, channel: string, args: unknown[]): Promise<unknown> {
    if (target.host.switching) await target.host.switching
    const stubId = target.workspace.id
    if (!registry.isLive(target)) {
      if (WRITE_CHANNELS.has(channel)) throw new RemoteUnavailable(unavailableMessage(target))
      if (snapshots.has(stubId, channel, args)) return snapshots.get(stubId, channel, args)
      const fallback = OFFLINE_DEFAULTS[channel]
      if (fallback) return fallback()
      throw new RemoteUnavailable(unavailableMessage(target))
    }
    try {
      const result = registry.mapIn(target.link.host, await target.host.conn.request(channel, args))
      if (SNAPSHOT_CHANNELS.has(channel)) snapshots.set(stubId, channel, args, result)
      recordSessions(target.host, channel, result)
      return result
    } catch (error) {
      // The link dropped mid-call: a read still has its last answer.
      const fallBack =
        !WRITE_CHANNELS.has(channel) &&
        !target.host.conn.connected &&
        snapshots.has(stubId, channel, args)
      if (fallBack) return snapshots.get(stubId, channel, args)
      throw error
    }
  }

  async function forwardToHost(
    entry: HostEntry,
    channel: string,
    args: unknown[]
  ): Promise<unknown> {
    if (!entry.conn.connected) {
      if (WRITE_CHANNELS.has(channel)) {
        throw new RemoteUnavailable(`${entry.host} is not connected. Nothing was sent or queued.`)
      }
      return channel === 'terminal:runtimeState' ? undefined : null
    }
    const result = registry.mapIn(entry.host, await entry.conn.request(channel, args))
    recordSessions(entry, channel, result)
    return result
  }

  return { forward, forwardToHost }
}
