/** READ never changes anything in the source; READ/WRITE lets Styr push updates back. */
export type SourceAccess = 'read' | 'read_write'

/**
 * One integration, switched on and configured for the workspace. There is one per provider and no
 * repository in it: the repositories come from the tasks' own `repoPath`s.
 */
export interface SourceConfig {
  /** The provider's name; there is one source per provider. */
  id: string
  provider: string
  access: SourceAccess
  enabled: boolean
  /** Minutes between automatic syncs; 0 turns polling off. */
  pollMinutes: number
  /** Only items carrying all of these labels; empty means all. */
  labels: string[]
  includeClosed: boolean
  /** Write-side options; ignored unless `access` is `read_write`. */
  mirrorStatus: boolean
  commentOnReview: boolean
}

/** A repository found in a task's checkout, and the folder it was found in. */
export interface SourceTarget {
  /** GitHub: `owner/name`. */
  target: string
  repoPath: string
}

export interface RemoteItem {
  id: string
  url: string
  title: string
  body: string
  state: 'open' | 'closed'
  labels: string[]
  updatedAt: string
  /** Items that block this one at the source. Undefined means unknown, not none. */
  blockedBy?: { target: string; id: string }[]
}

/** What the last sync of a source did, shown in the Integrations pane. */
export interface SourceSyncState {
  syncing: boolean
  lastAt?: string
  error?: string
  created: number
  updated: number
}

/** Whether an adapter's command-line tool is usable. */
export type CliStatus =
  | { state: 'missing' }
  | { state: 'outdated'; version: string; minimum: string }
  | { state: 'unauthenticated'; version: string }
  | { state: 'ready'; version: string; account?: string }

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  /** The command itself could not be found. */
  notFound?: boolean
}

/** How an adapter runs its CLI. Injected so tests never touch a real one. */
export type CommandRunner = (command: string, args: string[]) => Promise<RunResult>

export interface ListOptions {
  limit: number
}

/** Every call that changes something in the source. Reachable only through `writableSource`. */
export interface SourceWriter {
  close(id: string): Promise<void>
  reopen(id: string): Promise<void>
  comment(id: string, body: string): Promise<void>
}

/** The read half. An adapter has no write methods; writers are private to `writableSource`. */
export interface SourceAdapter {
  readonly provider: string
  readonly label: string
  /** Short prefix for tags imported from the source's labels. */
  readonly tagPrefix: string
  status(run: CommandRunner): Promise<CliStatus>
  /** Which repository of this provider a checkout belongs to, or null (not a git repo, other host). */
  detectTarget(repoPath: string): string | null
  list(
    config: SourceConfig,
    run: CommandRunner,
    target: string,
    options: ListOptions
  ): Promise<RemoteItem[]>
  get(run: CommandRunner, target: string, id: string): Promise<RemoteItem>
  /** Turns what a user pasted (`#42`, `42`, a URL) into an item; a URL names its own repository. */
  parseRef(text: string, defaultTarget: string | null): { target: string; id: string } | null
}
