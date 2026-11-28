import { agentProgramProvider } from '@core/handoff.js'
import type { AgentProviderId } from '@core/providers/types.js'
import { useAgentChat, useAgentConversation } from '../agentChat/useAgentChat.js'
import type { BlockListState } from './blockList.js'

/**
 * An agent CLI running in the native engine's block list: drawn by Styr from its conversation
 * (`useAgentChat`, shared with the xterm.js engine) when its provider has an adapter, the
 * conversation is being written and the tab's Chat switch is on; otherwise its own TUI shows.
 */
export function useAgentSession({
  sessionId,
  list,
  agentProvider,
  agentWaiting,
  chat,
  write
}: {
  sessionId: string
  list: BlockListState | null
  agentProvider?: AgentProviderId
  agentWaiting?: string | null
  /** The tab's Chat switch. */
  chat: boolean
  write: (data: string) => void
}) {
  const running = list?.active.kind === 'running' ? list.active : null
  const provider = running ? (agentProgramProvider(running.command) ?? agentProvider) : undefined
  const agent = useAgentChat({
    sessionId,
    run: running?.id ?? null,
    provider,
    agentWaiting,
    conversation: useAgentConversation(sessionId),
    write
  })
  return {
    ...agent,
    running,
    agentReady: agent.ready,
    agentMode: agent.ready && chat && !agent.tuiRequested
  }
}
