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
  /** The request and field mapping of a REST source; absent for every other provider. */
  rest?: RestSourceSettings
}

export const REST_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type RestMethod = (typeof REST_METHODS)[number]

export interface RestHeader {
  name: string
  value: string
  /** Off keeps the row in the editor without sending it. */
  enabled: boolean
}

/** One HTTP request, as edited in the REST pane. */
export interface RestRequest {
  method: RestMethod
  url: string
  headers: RestHeader[]
  /** Sent only for methods that carry one (not GET). */
  body: string
}

/**
 * Where an item's fields sit in the JSON reply, as dot paths (`data.items`, `fields.summary`,
 * `labels[0].name`). `items` points at the array; empty means the reply itself is the array.
 */
export interface RestMapping {
  items: string
  id: string
  title: string
  body: string
  url: string
  /** Empty means every item is open. */
  state: string
  /** Values of `state` that mean closed, compared without case. */
  closedValues: string[]
  /** Empty means a change is detected from the content instead. */
  updatedAt: string
  /** An array of strings, or of objects whose `name` is used. */
  labels: string
}

export interface RestSourceSettings {
  request: RestRequest
  mapping: RestMapping
}

/** A new REST source: a GET whose reply is an array of `{ id, title, body, url }`. */
export const DEFAULT_REST_SETTINGS: RestSourceSettings = {
  request: { method: 'GET', url: '', headers: [], body: '' },
  mapping: {
    items: '',
    id: 'id',
    title: 'title',
    body: 'body',
    url: 'url',
    state: '',
    closedValues: ['closed', 'done'],
    updatedAt: '',
    labels: ''
  }
}

/** What the REST pane's test shows: the raw reply and, when it parses, the mapped items. */
export interface RestTestResult {
  /** Set when no reply came back at all (bad URL, refused, timed out). */
  error?: string
  status?: number
  statusText?: string
  durationMs: number
  headers: [string, string][]
  /** Pretty-printed when JSON, cut at a size limit. */
  body: string
  truncated: boolean
  /** The first mapped items, or why mapping failed. */
  items?: RemoteItem[]
  total?: number
  mappingError?: string
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

/** One line of a sync's review list: an item and what applying it would do to the board. */
export interface SyncPreviewEntry {
  itemId: string
  kind: 'create' | 'update'
  /** The task's title after the sync. */
  title: string
  taskId?: string
  /** What visibly changes, in words; empty for a new task. */
  changes: string[]
  url?: string
}

/** What a reviewed sync would do, for the user to pick from before anything is applied. */
export interface SyncPreview {
  entries: SyncPreviewEntry[]
  /** Set when the source could not be read; `entries` is then empty. */
  error?: string
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
  /**
   * A source that is not found in the tasks' checkouts (a REST endpoint) has one target, always
   * this; its tasks get the default repo path.
   */
  readonly fixedTarget?: string
  /**
   * Imports are reviewed first: the source never syncs on a timer, and a sync applies only the
   * items the user ticked in its preview.
   */
  readonly reviewImports?: boolean
  status(run: CommandRunner): Promise<CliStatus>
  /** Which repository of this provider a checkout belongs to, or null (not a git repo, other host). */
  detectTarget(repoPath: string): string | null
  list(
    config: SourceConfig,
    run: CommandRunner,
    target: string,
    options: ListOptions
  ): Promise<RemoteItem[]>
  get(config: SourceConfig, run: CommandRunner, target: string, id: string): Promise<RemoteItem>
  /** Turns what a user pasted (`#42`, `42`, a URL) into an item; a URL names its own repository. */
  parseRef(text: string, defaultTarget: string | null): { target: string; id: string } | null
}
