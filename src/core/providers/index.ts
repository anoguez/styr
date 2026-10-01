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
