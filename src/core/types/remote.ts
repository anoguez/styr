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

/**
 * A remote host's connection, one per host whatever the number of workspaces on it. `incompatible`:
 * the server answered but speaks another protocol, so nothing is forwarded until it is upgraded.
 */
export type RemoteConnectionStatus =
  'connecting' | 'connected' | 'reconnecting' | 'offline' | 'incompatible'

export interface RemoteHostState {
  host: string
  status: RemoteConnectionStatus
  /** Why the last attempt failed or the connection dropped: ssh's own words where it gave some. */
  lastError?: string
  /** When the next attempt starts (epoch ms), while reconnecting. */
  retryAt?: number
  /** The server's Styr version, once it has said hello. */
  serverVersion?: string
  /** When the server started, on its clock (ISO), for its uptime. */
  serverStartedAt?: string
  /**
   * This app's version, set while the server runs another one: the client offers to install the
   * matching server (the version lock), and never restarts it unasked.
   */
  upgradeTo?: string
  /** Disconnected by the user (Settings → Remote hosts): nothing reconnects until Connect. */
  userDisconnected?: boolean
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

/** What New workspace → Remote sends: the guided setup (`docs/architecture/remote.md`). */
export interface RemoteSetupDraft {
  name: string
  host: string
  /** The agent CLI to look for on the host; a missing one is a warning, not a refusal. */
  provider: 'claude' | 'codex'
}

export type RemoteSetupStep = 'check' | 'probe' | 'install' | 'create'

/** One step of a running setup, pushed as `remote:setupProgress`. */
export interface RemoteSetupProgress {
  host: string
  step: RemoteSetupStep
  state: 'running' | 'done' | 'failed'
  /** What the step found or is doing, for people. */
  detail?: string
}

/**
 * How the server reached the host: the host downloaded the bundle from the release, this computer
 * uploaded it (the fallback), it was unpacked already, or a server of this version was running.
 */
export type RemoteTransfer = 'download' | 'upload' | 'installed' | 'running'

export interface RemoteSetupResult {
  /** The local stub's id: the app has switched to it. */
  workspaceId: string
  transfer: RemoteTransfer
  /** Missing git or CLI, no systemd, an older server still running … */
  warnings: string[]
  /** Set when systemd runs the server but lingering is off: the command to copy, never run. */
  lingerCommand?: string
}

/** An agent that a server restart or stop would end. */
export interface RemoteRunningAgent {
  title: string
  workspace?: string
}

export interface RemoteRunningAgents {
  /** False when the host is not connected, so the list could not be read. */
  known: boolean
  agents: RemoteRunningAgent[]
}
