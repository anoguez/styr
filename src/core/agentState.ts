import type { AgentConversation } from './agentConversation.js'
import type { Task, TaskStatus } from './types.js'

export const AGENT_STATES = ['ready', 'working', 'waiting', 'idle', 'exited'] as const
export type AgentState = (typeof AGENT_STATES)[number]

export const AGENT_STATE_LABELS: Record<AgentState, string> = {
  ready: 'Ready',
  working: 'Working',
  waiting: 'Waiting on you',
  idle: 'Idle',
  exited: 'Stopped'
}

export interface AgentStatus {
  taskId: string
  state: AgentState
  at: string
  sessionId?: string
  lastMessage?: string
  /**
   * What a `waiting` agent waits on, when Styr knows: a permission prompt, or a question it asked
   * (AskUserQuestion). Absent when it is not waiting or nothing says which (`withConversationWait`).
   */
  waitingOn?: AgentWait
  branch?: string
  /** Helpers the agent spawned in its current session, oldest first. Absent when there are none. */
  subagents?: SubagentStatus[]
  /** Set for agents of other workspaces (tray, notifications); task ids repeat across them. */
  workspaceId?: string
  workspaceName?: string
}

export const AGENT_WAITS = ['permission', 'question'] as const
export type AgentWait = (typeof AGENT_WAITS)[number]

/** The lastMessage of an agent waiting on a question: "Asked you a question: <header>". */
export const ASKED_A_QUESTION = 'Asked you a question'

/**
 * `status` as the agent's conversation shows it (the usage mod's file, a Codex thread): an agent
 * whose conversation waits on a question or an approval is `waiting`, on that, whatever its last
 * hook said. AskUserQuestion fires `PreToolUse` (working) and a permission `Notification`, so the
 * hooks alone read a question as working or as a permission. Its lastMessage names the question
 * by its first header (its text when it has none). A stopped agent stays stopped.
 */
export function withConversationWait(
  status: AgentStatus,
  conversation: Pick<AgentConversation, 'question' | 'approval'> | null | undefined
): AgentStatus {
  if (status.state === 'exited' || !conversation) return status
  const { question, approval } = conversation
  if (question) {
    const first = question.questions[0]
    const name = (first?.header || first?.question || '').trim()
    return {
      ...status,
      state: 'waiting',
      waitingOn: 'question',
      lastMessage: name ? `${ASKED_A_QUESTION}: ${name}` : ASKED_A_QUESTION
    }
  }
  if (approval) {
    return { ...status, state: 'waiting', waitingOn: 'permission', lastMessage: approval.prompt }
  }
  return status
}

/**
 * A helper agent the task's agent spawned (Claude Code's Agent tool, a Codex child thread). It is
 * part of its parent, not an agent of its own: it never adds to a count, a badge or the sort order.
 */
export interface SubagentStatus {
  id: string
  label: string
  state: 'running' | 'done'
  startedAt: string
  endedAt?: string
  lastMessage?: string
}

/** Subagent records go to their own folder, never the parent's status file (`agentStore.ts`). */
export const SUBAGENT_EVENTS = ['SubagentStart', 'SubagentStop'] as const

export function runningSubagents(status: Pick<AgentStatus, 'subagents'> | undefined): number {
  return status?.subagents?.filter((subagent) => subagent.state === 'running').length ?? 0
}

export function subagentCountLabel(count: number): string {
  return `${count} subagent${count === 1 ? '' : 's'}`
}

/** Up to this many rows show in full; past it the card shows `SUBAGENTS_SHOWN` and a toggle. */
export const SUBAGENTS_IN_FULL = 4
export const SUBAGENTS_SHOWN = 3

/** What a card shows of its subagents: the rows, and the toggle text when some are folded away. */
export function visibleSubagents(
  subagents: readonly SubagentStatus[],
  expanded: boolean
): { rows: readonly SubagentStatus[]; toggle?: string } {
  if (subagents.length <= SUBAGENTS_IN_FULL) return { rows: subagents }
  if (expanded) return { rows: subagents, toggle: 'Show fewer' }
  const hidden = subagents.slice(SUBAGENTS_SHOWN)
  const running = hidden.filter((subagent) => subagent.state === 'running').length
  return {
    rows: subagents.slice(0, SUBAGENTS_SHOWN),
    toggle: `+${hidden.length} more${running ? ` · ${running} running` : ''}`
  }
}

/** Task ids are only unique within a workspace, so anything keyed across workspaces needs both. */
export function agentKey(status: Pick<AgentStatus, 'taskId' | 'workspaceId'>): string {
  return status.workspaceId ? `${status.workspaceId}:${status.taskId}` : status.taskId
}

/**
 * Whether an agent has dropped out of the active list. Done work belongs in the Done column, not in
 * a list of things that might still need you — including when its last hook event was a
 * Notification, which a finished session leaves behind while it sits at an idle prompt.
 */
export function isAgentArchived(task: { status: TaskStatus; archivedAt?: string }): boolean {
  return task.status === 'done' || Boolean(task.archivedAt)
}

/** Waiting first — it is the only state that costs you time if you miss it. */
export const AGENT_STATE_ORDER: Record<AgentState, number> = {
  waiting: 0,
  working: 1,
  ready: 2,
  idle: 3,
  exited: 4
}

/** Most urgent first, then most recently changed. */
export function compareAgentStatus(a: AgentStatus, b: AgentStatus): number {
  return AGENT_STATE_ORDER[a.state] - AGENT_STATE_ORDER[b.state] || b.at.localeCompare(a.at)
}

/**
 * Which hook event maps to which state. SessionStart only means the session is open — a resume
 * fires it with no turn in flight, so it is not work. PreToolUse flips back to working after you
 * answer a permission prompt, which Notification would otherwise leave stuck on waiting.
 */
export const EVENT_STATE: Record<string, AgentState> = {
  SessionStart: 'ready',
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  Notification: 'waiting',
  Stop: 'idle',
  TerminalExit: 'exited'
}

/**
 * The state the board shows for an agent, which can differ from the hook's. An agent that ended its
 * turn on an In Review task left outside Dispatch reads _Waiting on you_: nothing else will move that
 * work forward. A dispatched task stays _Idle_ — Dispatch picks the review up, so only a real prompt
 * (permission, a question) is waiting. Display only: Dispatch slots and the "ask once it stops"
 * guards read the hook's state, where this agent is idle.
 */
export function shownAgentState(
  state: AgentState,
  task: Pick<Task, 'status' | 'orchestrate'> & Partial<Pick<Task, 'readiness'>>
): AgentState {
  if (state !== 'idle' || task.status !== 'in_review' || task.orchestrate) return state
  return task.readiness === 'needs_spec' ? state : 'waiting'
}

/** `agents` with each state replaced by `shownAgentState`; agents of unknown tasks pass through. */
export function shownAgents(
  agents: ReadonlyMap<string, AgentStatus>,
  tasks: readonly Pick<Task, 'id' | 'status' | 'orchestrate' | 'readiness'>[]
): Map<string, AgentStatus> {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const shown = new Map<string, AgentStatus>()
  for (const [id, status] of agents) {
    const task = byId.get(id)
    const state = task ? shownAgentState(status.state, task) : status.state
    shown.set(id, state === status.state ? status : { ...status, state })
  }
  return shown
}
