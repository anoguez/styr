import { loadSettings } from '../settingsStore.js'
import type { Settings, SourceConfig, SourceTarget } from '../types.js'
import { githubAdapter, githubWriter, runCommand } from './github.js'
import type { CommandRunner, SourceAdapter, SourceWriter } from './types.js'

export * from './types.js'
export { runCommand }

/** Thrown for any attempt to change a source that is not set to read/write. */
export class SourceReadOnlyError extends Error {
  constructor(source: string) {
    super(`Source "${source}" is read-only, so Styr will not change anything in it.`)
    this.name = 'SourceReadOnlyError'
  }
}

const ADAPTERS: readonly SourceAdapter[] = [githubAdapter]

/** Not exported: a writer can only be had through `writableSource`'s guard. */
const WRITERS: Record<string, (target: string, run: CommandRunner) => SourceWriter> = {
  github: githubWriter
}

/** The one place an adapter is chosen. */
export function adapterFor(provider: string): SourceAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.provider === provider)
}

export function sourceProviders(): { provider: string; label: string }[] {
  return ADAPTERS.map(({ provider, label }) => ({ provider, label }))
}

/**
 * The sources that may act. External sources are experimental, so with the flag off there are
 * none — which also makes `writableSource` refuse, and sync, polling and the MCP tools do nothing.
 */
export function activeSources(settings: Settings): SourceConfig[] {
  return settings.experimental.externalSources ? settings.sources : []
}

export function currentSources(): SourceConfig[] {
  return activeSources(loadSettings())
}

/**
 * The only way to obtain a `SourceWriter`. It looks the source up again by id on every call, so
 * a source switched to read-only (or disabled, or removed) stops being writable at once, whatever
 * copy of its config the caller was holding.
 */
export function writableSource(
  sourceId: string,
  target: string,
  run: CommandRunner = runCommand,
  sources: () => SourceConfig[] = currentSources
): SourceWriter {
  const guard = (): void => {
    const config = sources().find((source) => source.id === sourceId)
    if (!config) throw new Error(`Source ${sourceId} is not set up.`)
    if (config.access !== 'read_write' || !config.enabled)
      throw new SourceReadOnlyError(config.provider)
  }
  guard()
  const provider = sources().find((source) => source.id === sourceId)!.provider
  const make = WRITERS[provider]
  if (!make) throw new Error(`No adapter for ${provider}.`)
  const inner = make(target, run)
  // checked again at every call, so a downgrade between obtaining the handle and using it still refuses
  return {
    close: (id) => (guard(), inner.close(id)),
    reopen: (id) => (guard(), inner.reopen(id)),
    comment: (id, body) => (guard(), inner.comment(id, body))
  }
}

/** The repositories the workspace's tasks (and default repo path) live in, one entry per repository. */
export function sourceTargets(adapter: SourceAdapter, repoPaths: string[]): SourceTarget[] {
  const found = new Map<string, SourceTarget>()
  for (const repoPath of repoPaths) {
    if (!repoPath) continue
    const target = adapter.detectTarget(repoPath)
    if (target && !found.has(target.toLowerCase()))
      found.set(target.toLowerCase(), { target, repoPath })
  }
  return [...found.values()]
}
