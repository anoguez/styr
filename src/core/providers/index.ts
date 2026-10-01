import type { Settings, Task } from '../types.js'
import { claudeProvider } from './claude.js'
import type { AgentProvider } from './types.js'

export type { AgentProvider, AgentProviderId, ProviderCommandInput } from './types.js'

/**
 * The one place a provider is chosen. Claude is the only one so far; when another lands, this
 * reads the choice from settings or the task rather than callers branching on it themselves.
 */
export function providerFor(_settings: Settings, _task?: Task): AgentProvider {
  return claudeProvider
}

const PROVIDERS: readonly AgentProvider[] = [claudeProvider]

/**
 * `env` without any provider's session markers. Every provider's, not just the chosen one's: a
 * plain shell tab can run any agent CLI. Pure, so it can be tested without spawning a terminal.
 */
export function withoutSessionMarkers(env: Record<string, string>): Record<string, string> {
  const markers = new Set(PROVIDERS.flatMap((provider) => provider.sessionEnvKeys))
  return Object.fromEntries(Object.entries(env).filter(([key]) => !markers.has(key)))
}
