import type { CliStatus, RemoteItem, SourceConfig } from '../types.js'

export type { CliStatus }

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
