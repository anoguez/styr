import { DEFAULT_REST_SETTINGS, type SourceConfig } from './types.js'

/** The provider of every REST source. A workspace may have any number of them. */
export const REST_PROVIDER = 'rest'

/** What a REST source is called before it is given a name. */
export const REST_DEFAULT_NAME = 'REST API'

export function isRestSource(source: SourceConfig): boolean {
  return source.provider === REST_PROVIDER
}

/** The name the pane, the task dialog and the MCP tools show for a source. */
export function sourceName(source: SourceConfig): string {
  return source.name?.trim() || (isRestSource(source) ? REST_DEFAULT_NAME : source.provider)
}

/**
 * A new, switched-off REST source. Its id never repeats one in use, and carries a random part so a
 * deleted source's tasks are never taken over by the next one added: links match on the id.
 */
export function newRestSource(
  existing: readonly SourceConfig[],
  random: () => string = () => crypto.randomUUID().slice(0, 8)
): SourceConfig {
  let id = REST_PROVIDER
  while (existing.some((source) => source.id === id)) id = `${REST_PROVIDER}-${random()}`
  const names = new Set(existing.filter(isRestSource).map(sourceName))
  let name = REST_DEFAULT_NAME
  for (let n = 2; names.has(name); n++) name = `${REST_DEFAULT_NAME} ${n}`
  return {
    id,
    provider: REST_PROVIDER,
    name,
    access: 'read',
    enabled: false,
    // reviewed imports never poll
    pollMinutes: 0,
    labels: [],
    includeClosed: false,
    mirrorStatus: false,
    commentOnReview: false,
    rest: DEFAULT_REST_SETTINGS
  }
}

/** A copy of a REST source under a new id, switched off so it imports nothing until reviewed. */
export function duplicateRestSource(
  existing: readonly SourceConfig[],
  source: SourceConfig,
  random?: () => string
): SourceConfig {
  const fresh = newRestSource(existing, random)
  const names = new Set(existing.filter(isRestSource).map(sourceName))
  const base = `${sourceName(source)} copy`
  let name = base
  for (let n = 2; names.has(name); n++) name = `${base} ${n}`
  return { ...structuredClone(source), id: fresh.id, name, enabled: false }
}
