/**
 * Remote workspaces: a board that lives on another machine, under a headless `styr serve`, and is
 * reached over `ssh` (`docs/architecture/remote.md`). Locally there is only a stub folder whose
 * `workspace.json` holds the link below.
 */

/** Where a remote workspace lives: an `ssh` host and the workspace's id on that host's server. */
export interface RemoteWorkspaceLink {
  /** Whatever `ssh` accepts: an alias from `~/.ssh/config`, `user@100.x.y.z`. */
  host: string
  /** The workspace's id on the server, which need not match the local stub's id. */
  workspaceId: string
  /**
   * The command that starts the server on the host, as typed (a POSIX shell runs it there).
   * `serve attach` is appended. Unset means `styr`.
   */
  server?: string
}

/** A remote host's connection, one per host whatever the number of workspaces on it. */
export type RemoteConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline'

export interface RemoteHostState {
  host: string
  status: RemoteConnectionStatus
  /** Why the last attempt failed or the connection dropped: ssh's own words where it gave some. */
  lastError?: string
  /** When the next attempt starts (epoch ms), while reconnecting. */
  retryAt?: number
  /** The server's Styr version, once it has said hello. */
  serverVersion?: string
  /** The workspace the server is showing (its own id and name), once known. */
  serverWorkspace?: { id: string; name: string }
}

/** One remote workspace as the client sees it. */
export interface RemoteWorkspaceState {
  host: string
  remoteWorkspaceId: string
  /**
   * Connected and the server is showing this workspace: the board is live and writable. Anything
   * else shows the last snapshot read-only.
   */
  live: boolean
  /** The name of the workspace the server shows instead, when another client moved it. */
  elsewhere?: string
  /** Why the workspace cannot be shown, such as an id the server does not have. */
  error?: string
}

/** What the renderer shows: the flag, every host's connection and every remote workspace. */
export interface RemoteState {
  enabled: boolean
  hosts: RemoteHostState[]
  /** Keyed by the local stub's id. */
  workspaces: Record<string, RemoteWorkspaceState>
}

/** What the minimal "Add remote workspace" form sends. */
export interface RemoteWorkspaceDraft {
  name: string
  host: string
  workspaceId: string
  server?: string
}
