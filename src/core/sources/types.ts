import type { CliStatus, RemoteItem, SourceCheck, SourceConfig } from '../types.js'

export type { CliStatus, SourceCheck }

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

/** The read half. An adapter has no write methods of its own — `writer` is the only way in. */
export interface SourceAdapter {
  readonly provider: string
  readonly label: string
  /** Short prefix for tags imported from the source's labels. */
  readonly tagPrefix: string
  status(run: CommandRunner): Promise<CliStatus>
  check(config: SourceConfig, run: CommandRunner): Promise<SourceCheck>
  list(config: SourceConfig, run: CommandRunner, options: ListOptions): Promise<RemoteItem[]>
  get(config: SourceConfig, run: CommandRunner, id: string): Promise<RemoteItem>
  /** Turns what a user pasted (`#42`, `42`, a URL) into an item id, or null. */
  parseRef(config: SourceConfig, text: string): string | null
  writer(config: SourceConfig, run: CommandRunner): SourceWriter
}
