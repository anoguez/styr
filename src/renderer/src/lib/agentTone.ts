import type { AgentState } from '@core/agentState.js'

/** One colour per agent state, shared by the cards, the agents sidebar and the terminal tabs. */
export const AGENT_TONE: Record<AgentState, string> = {
  ready: 'text-dim',
  working: 'text-[var(--color-col-progress-text)]',
  waiting: 'text-[var(--color-col-review-text)]',
  idle: 'text-[var(--color-col-done-text)]',
  exited: 'text-faint'
}
