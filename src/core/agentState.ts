import type { TaskStatus } from './types.js'

export const AGENT_STATES = ['ready', 'working', 'waiting', 'idle', 'exited'] as const
export type AgentState = (typeof AGENT_STATES)[number]

export const AGENT_STATE_LABELS: Record<AgentState, string> = {
  ready: 'Ready',
  working: 'Working',
  waiting: 'Waiting on you',
  idle: 'Finished',
  exited: 'Stopped'
}

export interface AgentStatus {
  taskId: string
  state: AgentState
  at: string
  sessionId?: string
  lastMessage?: string
  branch?: string
  /** Set for agents of other workspaces (tray, notifications); task ids repeat across them. */
  workspaceId?: string
  workspaceName?: string
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
