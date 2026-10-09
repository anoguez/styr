import type { ConversationAdapter } from '../agentConversation.js'
import { claudeConversation } from './claudeConversation.js'
import type { AgentProviderId } from './types.js'

/**
 * How each agent CLI's conversation is drawn as blocks (see `agentConversation.ts`). A provider
 * without an adapter, or without a conversation source yet, keeps its own TUI. Pure, so the
 * renderer can import it — unlike `providers/index.ts`, whose providers touch the filesystem.
 */
const ADAPTERS: Partial<Record<AgentProviderId, ConversationAdapter>> = {
  claude: claudeConversation
}

export function conversationAdapter(id: AgentProviderId): ConversationAdapter | undefined {
  return ADAPTERS[id]
}
