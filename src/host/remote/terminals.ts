import type { TerminalOutput, TerminalSessionInfo } from '@core/types.js'
import { SESSION_RESULT_CHANNELS, SESSION_SENDS } from './channels.js'
import { UNLINKED, type HostEntry, type RemoteRegistry } from './registry.js'
import { TerminalMirror } from './terminalMirror.js'
import { RemoteInvalidResponse } from './validation.js'

/**
 * Remote terminal sessions on the client: which host each one runs on, attaching to its stream
 * (`terminal:backlog` becomes `terminal:attach`), the mirror the Styr Terminal engine draws from,
 * and the reattach after a reconnect. A local tab stays local whatever workspace is open.
 */

/** Sent before a reattach's backlog, so the view starts again rather than repeating itself. */
export const TERMINAL_RESET = '\x1bc'

const EMPTY_OUTPUT: TerminalOutput = { data: '', sequence: 0, marks: [] }

export interface RemoteTerminalPorts {
  broadcast(channel: string, payload?: unknown): void
  /** Whether a session runs on this machine. */
  isLocalSession(id: string): boolean
}

type DataListener = (id: string, output: TerminalOutput) => void
type ExitListener = (id: string) => void

export function createRemoteTerminals(registry: RemoteRegistry, ports: RemoteTerminalPorts) {
  /** The host of every remote session seen, by session id. */
  const sessionHosts = new Map<string, string>()
  const dataListeners = new Set<DataListener>()
  const exitListeners = new Set<ExitListener>()

  /** The host a session runs on: one it was seen on, else the active remote workspace's host. */
  function sessionHost(id: string): HostEntry | undefined {
    if (!registry.enabled || ports.isLocalSession(id)) return undefined
    const known = sessionHosts.get(id)
    if (known) return registry.hosts.get(known)
    return registry.activeRemote()?.host
  }

  /**
   * Whether a server may speak for this session id: never one running on this machine, nor one
   * already seen on another host. A compromised server must not reach another host's tab or a
   * local one by naming its id.
   */
  function mayClaim(entry: HostEntry, id: string): boolean {
    if (ports.isLocalSession(id)) return false
    const known = sessionHosts.get(id)
    return known === undefined || known === entry.host
  }

  /** Tags a server's session with its host; false (and nothing kept) if it may not claim the id. */
  function tagSession(entry: HostEntry, session: TerminalSessionInfo): boolean {
    if (!mayClaim(entry, session.id)) return false
    session.host = entry.host
    sessionHosts.set(session.id, entry.host)
    entry.sessions.set(session.id, session)
    return true
  }

  /**
   * Remembers the host of every session a call returned, and tags each with it. A session whose
   * id the server may not claim fails the call (`mayClaim`).
   */
  function recordSessions(entry: HostEntry, channel: string, result: unknown): void {
    const sessions =
      channel === 'orchestrate:run' && Array.isArray(result)
        ? result.map((item: { session: TerminalSessionInfo }) => item.session)
        : SESSION_RESULT_CHANNELS.has(channel) && result && typeof result === 'object'
          ? [result as TerminalSessionInfo]
          : []
    for (const session of sessions) {
      if (!tagSession(entry, session)) {
        throw new RemoteInvalidResponse(
          `${entry.host} answered ${channel} with a session it does not own. Nothing was shown.`
        )
      }
    }
  }

  /** This machine's sessions, then each host's: the live list, or the last one while disconnected. */
  async function list(local: TerminalSessionInfo[]): Promise<TerminalSessionInfo[]> {
    if (!registry.enabled) return local
    const remote = await Promise.all([...registry.hosts.values()].map(listHost))
    return [...local, ...remote.flat()]
  }

  async function listHost(entry: HostEntry): Promise<TerminalSessionInfo[]> {
    if (entry.conn.connected) {
      try {
        const listed = registry.mapIn(
          entry.host,
          await entry.conn.request('terminal:list')
        ) as TerminalSessionInfo[]
        entry.sessions.clear()
        for (const session of listed) {
          // One the server may not claim is left out (`mayClaim`).
          if (!session.workspaceId?.startsWith(UNLINKED)) tagSession(entry, session)
        }
      } catch {
        // Keep the last list.
      }
    }
    return [...entry.sessions.values()]
  }

  /** Sends output to the views and the engine. */
  function emit(id: string, output: TerminalOutput): void {
    for (const listener of dataListeners) listener(id, output)
    ports.broadcast('terminal:data', { id, ...output })
  }

  /**
   * `terminal:backlog` for a remote session: attaches this client to its stream and returns the
   * server's backlog, keeping a mirror for the Styr Terminal engine. While disconnected, the last
   * mirror (or nothing) is shown; the reattach on reconnect brings it up to date.
   */
  async function attach(entry: HostEntry, id: string): Promise<TerminalOutput> {
    if (!entry.conn.connected) {
      entry.attached.add(id)
      return entry.mirrors.get(id)?.backlog() ?? EMPTY_OUTPUT
    }
    entry.attaching.set(id, [])
    try {
      const backlog = (await entry.conn.request('terminal:attach', [id])) as TerminalOutput
      entry.attached.add(id)
      entry.mirrors.set(id, new TerminalMirror(backlog))
      flushEarly(entry, id)
      return backlog
    } finally {
      entry.attaching.delete(id)
    }
  }

  /**
   * Output that arrived while an attach was on its way, held back by `onData`: a line read in the
   * same chunk as the attach's reply is dispatched before the `await` resumes. Sent now, after the
   * backlog, skipping what the backlog already held.
   */
  function flushEarly(entry: HostEntry, id: string): void {
    const early = entry.attaching.get(id) ?? []
    entry.attaching.delete(id)
    const mirror = entry.mirrors.get(id)
    for (const output of early.sort((a, b) => a.sequence - b.sequence)) {
      if (mirror && !mirror.append(output)) continue
      emit(id, output)
    }
  }

  /**
   * Reattaches every terminal this client had open: what ran meanwhile arrives as the server's
   * backlog, written after a reset so the view does not repeat what it already showed. A session
   * the server no longer has (it restarted) is reported exited, as after an app restart.
   */
  async function reattach(entry: HostEntry): Promise<void> {
    if (entry.attached.size === 0) return
    let live: Set<string>
    try {
      const listed = (await entry.conn.request('terminal:list')) as TerminalSessionInfo[]
      live = new Set(listed.map((session) => session.id))
    } catch {
      return
    }
    for (const id of [...entry.attached]) {
      if (live.has(id)) await reattachOne(entry, id)
      else onExit(entry, { id, exitCode: -1 })
    }
  }

  async function reattachOne(entry: HostEntry, id: string): Promise<void> {
    entry.attaching.set(id, [])
    try {
      const backlog = (await entry.conn.request('terminal:attach', [id])) as TerminalOutput
      const mirror = entry.mirrors.get(id)
      if (!mirror || backlog.sequence > mirror.lastSequence) {
        if (mirror) mirror.reset(backlog)
        else entry.mirrors.set(id, new TerminalMirror(backlog))
        emit(id, {
          data: TERMINAL_RESET + backlog.data,
          sequence: backlog.sequence,
          marks: backlog.marks.map((mark) => ({
            ...mark,
            offset: mark.offset + TERMINAL_RESET.length
          }))
        })
      }
      flushEarly(entry, id)
    } catch {
      // Left detached; the next reconnect tries again.
    } finally {
      entry.attaching.delete(id)
    }
  }

  /** `terminal:data` from a server. */
  function onData(entry: HostEntry, payload: { id: string } & TerminalOutput): void {
    const { id, ...output } = payload
    // Only a terminal this client attached to on that host: a server sends no other.
    if (!entry.attached.has(id) && !entry.attaching.has(id)) return
    if (!mayClaim(entry, id)) return
    sessionHosts.set(id, entry.host)
    const early = entry.attaching.get(id)
    // Held until the attach's backlog is in place (`flushEarly`), so a reset cannot wipe it.
    if (early) return void early.push(output)
    entry.mirrors.get(id)?.append(output)
    emit(id, output)
  }

  /** `terminal:exit` from a server, or a session a restarted server no longer has. */
  function onExit(entry: HostEntry, payload: { id: string; exitCode: number }): void {
    if (!mayClaim(entry, payload.id)) return
    sessionHosts.delete(payload.id)
    entry.sessions.delete(payload.id)
    entry.attached.delete(payload.id)
    entry.mirrors.delete(payload.id)
    for (const listener of exitListeners) listener(payload.id)
    ports.broadcast('terminal:exit', payload)
  }

  /** A one-way call (`terminal:write`, `terminal:resize`): sent where the session runs, or dropped. */
  function send(channel: string, args: unknown[], local: () => void): void {
    if (!SESSION_SENDS.has(channel)) return local()
    const id = String(args[0])
    const entry = sessionHost(id)
    if (!entry) return local()
    entry.conn.notify(channel, args)
    // The PTY takes the size of the client that focused it last; resizing is what a view does
    // when it is shown, so it counts as focusing.
    if (channel === 'terminal:resize') entry.conn.notify('terminal:focus', [id])
  }

  return {
    sessionHost,
    tagSession,
    recordSessions,
    list,
    attach,
    reattach,
    onData,
    onExit,
    send,
    isRemoteSession: (id: string): boolean => sessionHost(id) !== undefined,
    /** Whether `id` names a session on another host or this machine: `entry` may not speak for it. */
    foreign: (entry: HostEntry, id: string): boolean => !mayClaim(entry, id),
    /** The mirror's backlog for a remote session, for the engine's synchronous `backlog` port. */
    mirrorBacklog(id: string): TerminalOutput | undefined {
      const host = sessionHosts.get(id)
      return host ? registry.hosts.get(host)?.mirrors.get(id)?.backlog() : undefined
    },
    /** Makes sure a remote session is attached and mirrored (the engine's attach). */
    async ensureAttached(id: string): Promise<void> {
      const entry = sessionHost(id)
      if (entry && !entry.mirrors.has(id)) await attach(entry, id)
    },
    /** A host went away for good: its sessions are no longer routed to it. */
    forgetHost(entry: HostEntry): void {
      for (const id of entry.sessions.keys()) sessionHosts.delete(id)
    },
    onTerminalData: (listener: DataListener) => void dataListeners.add(listener),
    onTerminalExit: (listener: ExitListener) => void exitListeners.add(listener)
  }
}

export type RemoteTerminals = ReturnType<typeof createRemoteTerminals>
