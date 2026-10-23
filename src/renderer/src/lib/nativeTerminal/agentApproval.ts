import {
  approvalOptions,
  DEFAULT_APPROVAL_OPTIONS,
  type AgentConversation,
  type ConversationAdapter
} from '@core/agentConversation.js'
import type { ApprovalRequest } from '../../components/AgentBlockList.js'

/**
 * What the view shows while the agent waits: the request its channel carries, with its options, or
 * else what Styr's agent status says, answered by keys in the TUI.
 */
export function approvalRequest(
  conversation: AgentConversation | null,
  adapter: ConversationAdapter | undefined,
  waiting: string | null
): ApprovalRequest | null {
  const approval = conversation?.approval
  if (approval) {
    const described =
      approval.tool && adapter
        ? adapter.describeTool({
            id: approval.id,
            tool: approval.tool,
            input: approval.input ?? {}
          })
        : undefined
    return {
      prompt: approval.prompt,
      ...(approval.tool ? { tool: approval.tool } : {}),
      ...(described?.summary ? { summary: described.summary } : {}),
      ...(described?.edit ? { edit: described.edit } : {}),
      options: approvalOptions(approval),
      keys: false
    }
  }
  return waiting ? { prompt: waiting, options: DEFAULT_APPROVAL_OPTIONS, keys: true } : null
}
