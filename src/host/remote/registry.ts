import type { AgentStatus } from '@core/agentState.js'
import type {
  RemoteWorkspaceLink,
  TerminalOutput,
  TerminalSessionInfo,
  WorkspaceInfo,
  WorkspaceOverview,
  WorkspacesActivity
} from '@core/types.js'
import type { RemoteConnection } from './connection.js'
import type { TerminalMirror } from './terminalMirror.js'

/**
 * Which workspaces are remote, and what the client knows about each host: the state every part of
 * the remote router reads (`docs/architecture/remote.md`). It decides where a workspace's calls go
 * (`target`), whether its board is live, and maps a server's workspace ids to the local stubs that
 * link to them, so routing keys on the stub id plus the remote id, never on a task id alone.
 */

/** The connection as the router uses it (`RemoteConnection`). */
export type Connection = Pick<
  RemoteConnection,
  | 'state'
  | 'connected'
  | 'server'
  | 'start'
  | 'stop'
  | 'retryNow'
  | 'wake'
  | 'suspend'
  | 'request'
  | 'notify'
>

/** A local stub: a workspace whose folder only links to a host. */
export type Stub = WorkspaceInfo & { remote: RemoteWorkspaceLink }

/** One host: its connection, and everything learned from its server. */
export interface HostEntry {
  host: string
  conn: Connection
  /** The server's own workspace list, for its active workspace, names and counts. */
  overview?: WorkspaceOverview
  /** The server's active workspace id, kept current from its broadcasts. */
  serverActiveId?: string
  /** Set from a `workspaces:changed` until the overview is fetched again: not live meanwhile. */
  overviewStale: boolean
  /** The server should switch to this remote workspace once connected (a user's switch). */
  wantSwitch?: string
  switching?: Promise<void>
  /** Why a remote workspace cannot be shown, by remote id. */
  errors: Map<string, string>
  /** The server's rollup and tray, mapped to stub ids; dropped while disconnected. */
  activity?: WorkspacesActivity['byWorkspace']
  tray?: { statuses: AgentStatus[]; titles: Map<string, string> }
  /** The next tray model is a baseline after a (re)connect: it raises no notification. */
  trayBaseline: boolean
  /** Sessions last listed on this host, kept for tabs while disconnected. */
  sessions: Map<string, TerminalSessionInfo>
  /** Terminals this client attached to, reattached on reconnect. */
  attached: Set<string>
  mirrors: Map<string, TerminalMirror>
  /** Output that arrived while an attach was on its way, sent after its backlog. */
  attaching: Map<string, TerminalOutput[]>
  /** Disconnected from Settings → Remote hosts: stays offline until Connect. */
  userDisconnected: boolean
}

export function createHostEntry(host: string, conn: Connection): HostEntry {
  return {
    host,
    conn,
    overviewStale: false,
    errors: new Map(),
    trayBaseline: true,
    sessions: new Map(),
    attached: new Set(),
    mirrors: new Map(),
    attaching: new Map(),
    userDisconnected: false
  }
}

/** A remote workspace with its host: where its calls go. */
export interface RemoteTarget {
  kind: 'remote'
  workspace: Stub
  link: RemoteWorkspaceLink
  host: HostEntry
}

/** Where a call goes: the in-process host, a remote workspace, or one with the flag off. */
export type Target = { kind: 'local' } | { kind: 'disabled'; workspace: Stub } | RemoteTarget

/** The id given to a server workspace no stub links to: it matches no local workspace. */
export const UNLINKED = 'remote-unlinked:'

export interface RegistryPorts {
  /** `experimental.remoteWorkspaces`, read fresh. */
  enabled(): boolean
  /** The local workspaces, stubs with their links included (`listWorkspaces`). */
  workspaces(): WorkspaceInfo[]
  activeWorkspaceId(): string
}

export class RemoteRegistry {
  readonly hosts = new Map<string, HostEntry>()
  private flag = false
  private stubs = new Map<string, Stub>()

  constructor(private readonly ports: RegistryPorts) {}

  get enabled(): boolean {
    return this.flag
  }

  /** The stubs by local id. */
  get links(): ReadonlyMap<string, Stub> {
    return this.stubs
  }

  /** Whether anything remote exists at all: with nothing, the router is a pass-through. */
  get any(): boolean {
    return this.stubs.size > 0 || this.hosts.size > 0
  }

  activeId(): string {
    return this.ports.activeWorkspaceId()
  }

  /** Re-reads the flag and the stubs (cached: `listWorkspaces` reads the disk). */
  reload(): void {
    this.flag = this.ports.enabled()
    this.stubs = new Map(
      this.ports
        .workspaces()
        .filter((workspace): workspace is Stub => Boolean(workspace.remote))
        .map((workspace) => [workspace.id, workspace])
    )
  }

  /** One link per host that should be connected: none with the flag off. */
  wantedHosts(): Map<string, RemoteWorkspaceLink> {
    const wanted = new Map<string, RemoteWorkspaceLink>()
    if (!this.flag) return wanted
    for (const stub of this.stubs.values()) {
      if (!wanted.has(stub.remote.host)) wanted.set(stub.remote.host, stub.remote)
    }
    return wanted
  }

  target(workspaceId: string = this.activeId()): Target {
    const workspace = this.stubs.get(workspaceId)
    if (!workspace) return { kind: 'local' }
    const host = this.flag ? this.hosts.get(workspace.remote.host) : undefined
    if (!host) return { kind: 'disabled', workspace }
    return { kind: 'remote', workspace, link: workspace.remote, host }
  }

  activeRemote(): RemoteTarget | undefined {
    const target = this.target()
    return target.kind === 'remote' ? target : undefined
  }

  /** Connected, and the server shows this workspace: its board is live and writable. */
  isLive(target: RemoteTarget): boolean {
    const entry = target.host
    return (
      entry.conn.connected &&
      !entry.overviewStale &&
      !entry.switching &&
      entry.serverActiveId === target.link.workspaceId
    )
  }

  /** The active workspace is remote, on this host, and live. */
  activeOnLive(entry: HostEntry): boolean {
    const target = this.activeRemote()
    return target !== undefined && target.host === entry && this.isLive(target)
  }

  /** The stub linking to `serverId` on `host`, if any. */
  stubFor(host: string, serverId: string): Stub | undefined {
    for (const stub of this.stubs.values()) {
      if (stub.remote.host === host && stub.remote.workspaceId === serverId) return stub
    }
    return undefined
  }

  /**
   * A value from a server with its `workspaceId`s turned into the stubs' ids. A workspace no stub
   * links to gets a marker id that matches no local workspace, so it shows nowhere.
   */
  mapIn(host: string, value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.mapIn(host, item))
    if (!value || typeof value !== 'object') return value
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        key === 'workspaceId' && typeof item === 'string'
          ? (this.stubFor(host, item)?.id ?? `${UNLINKED}${host}/${item}`)
          : this.mapIn(host, item)
    }
    return out
  }

  /** The name of the workspace the server shows instead of `remoteId`, when another client moved it. */
  elsewhereName(entry: HostEntry, remoteId: string): string | undefined {
    if (!entry.conn.connected || !entry.serverActiveId || entry.serverActiveId === remoteId) {
      return undefined
    }
    const other = entry.overview?.workspaces.find((w) => w.id === entry.serverActiveId)
    return other?.name ?? entry.serverActiveId
  }
}
