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
  // Questions the agent asks (AskUserQuestion): its picker is answered in the terminal for now;
  // the status's keys must not stand in for it, since Enter there picks an option.
  // TODO(TASK-0030): draw the question card and answer it over `agent:answerQuestion`.
  const question = conversation?.question
  if (question) {
    const first = question.questions[0]?.question ?? 'The agent has a question for you.'
    const more = question.questions.length - 1
    return {
      prompt: more > 0 ? `${first} (and ${more} more)` : first,
      options: [],
      keys: false,
      inTui: true
    }
  }
  const approval = conversation?.approval
  // An older mod sent AskUserQuestion as a permission request: Allow would leave it unanswered.
  if (approval?.tool && adapter?.asksInTui?.(approval.tool)) {
    // A question, not a permission: Allow/Deny would hang it, so only the terminal answers it.
    return { prompt: approval.prompt, tool: approval.tool, options: [], keys: false, inTui: true }
  }
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
