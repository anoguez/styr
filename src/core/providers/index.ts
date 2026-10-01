import type { Settings, Task } from '../types.js'
import { claudeProvider } from './claude.js'
import { codexProvider } from './codex.js'
import type { AgentProvider, AgentProviderId } from './types.js'

export type { AgentProvider, AgentProviderId, ProviderCommandInput } from './types.js'

export function providerById(id: AgentProviderId): AgentProvider {
  return id === 'codex' ? codexProvider : claudeProvider
}

/**
 * The one place a provider is chosen. Claude is the only one so far; when another lands, this
 * reads the choice from settings or the task rather than callers branching on it themselves.
 */
export function providerFor(settings: Settings, task?: Task): AgentProvider {
  return providerById(task?.agentSession?.provider ?? settings.defaultProvider)
}

const PROVIDERS: readonly AgentProvider[] = [claudeProvider, codexProvider]

/**
 * `env` without any provider's session markers. Every provider's, not just the chosen one's: a
 * plain shell tab can run any agent CLI. Pure, so it can be tested without spawning a terminal.
 */
export function withoutSessionMarkers(env: Record<string, string>): Record<string, string> {
  const markers = new Set(PROVIDERS.flatMap((provider) => provider.sessionEnvKeys))
  return Object.fromEntries(Object.entries(env).filter(([key]) => !markers.has(key)))
}
