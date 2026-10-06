import { loadSettings } from '../settingsStore.js'
import type { SourceConfig } from '../types.js'
import { githubAdapter, runCommand } from './github.js'
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

/** The one place an adapter is chosen. */
export function adapterFor(provider: string): SourceAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.provider === provider)
}

export function sourceProviders(): { provider: string; label: string }[] {
  return ADAPTERS.map(({ provider, label }) => ({ provider, label }))
}

export function currentSources(): SourceConfig[] {
  return loadSettings().sources
}

/**
 * The only way to obtain a `SourceWriter`. It looks the source up again by id on every call, so
 * a source switched to read-only (or disabled, or removed) stops being writable at once, whatever
 * copy of its config the caller was holding.
 */
export function writableSource(
  sourceId: string,
  run: CommandRunner = runCommand,
  sources: () => SourceConfig[] = currentSources
): SourceWriter {
  const config = sources().find((source) => source.id === sourceId)
  if (!config) throw new Error(`Source ${sourceId} no longer exists.`)
  if (config.access !== 'read_write' || !config.enabled)
    throw new SourceReadOnlyError(config.name || config.repo)
  const adapter = adapterFor(config.provider)
  if (!adapter) throw new Error(`No adapter for ${config.provider}.`)
  return adapter.writer(config, run)
}
