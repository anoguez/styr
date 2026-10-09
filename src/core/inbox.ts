import { isAgentArchived, type AgentState, type AgentStatus } from './agentState.js'
import { indexTasks, openBlockers } from './blocking.js'
import type { Task, WorkspaceBoardSummary } from './types.js'

export const INBOX_GROUPS = ['needs', 'running', 'next', 'done'] as const
export type InboxGroup = (typeof INBOX_GROUPS)[number]

export const INBOX_GROUP_LABELS: Record<InboxGroup, string> = {
  needs: 'Needs you',
  running: 'Running',
  next: 'Up next',
  done: 'Done'
}

/** Why a task sits in its group — picks the wording and the actions the inbox offers for it. */
export type InboxKind =
  | 'waiting'
  | 'review'
  | 'spec'
  | 'running'
  | 'blocked'
  | 'queued'
  | 'resumable'
  | 'idle'
  | 'finished'
  | 'done'

export interface InboxItem {
  task: Task
  group: InboxGroup
  kind: InboxKind
  agent?: AgentStatus
  /** Position in the Orchestrate queue, 1-based, when the task is next in line. */
  queuedAt?: number
  /** Ids of the tasks this one is waiting on; set only for the `blocked` kind. */
  blockers?: string[]
  /** One line saying what the task wants from you. */
  reason: string
  /** When that became true: the agent's last event, else the task's last write. */
  at: string
}

/**
 * Whether a task sits in "Needs you" for review: its agent ended its turn on an In Review task that
 * does not still need a spec. Shared with the workspace switcher so the two cannot disagree.
 */
export function awaitsReview(
  task: { status: Task['status']; readiness?: Task['readiness'] },
  state: AgentState | undefined
): boolean {
  return state === 'idle' && task.status === 'in_review' && task.readiness !== 'needs_spec'
}

/**
 * Sorts the board into what needs you, what is running, what is next and what is finished. It is
 * derived from the same tasks and agent states as the board and writes nothing, so the two views
 * cannot disagree about a task. A working agent outranks everything: a task being worked on is not
 * waiting for a spec or a review, whatever its readiness says.
 */
export function classifyTask(
  task: Task,
  agent: AgentStatus | undefined,
  queuedAt?: number,
  blockers: readonly string[] = []
): Omit<InboxItem, 'task' | 'agent' | 'queuedAt'> {
  const fallbackAt = task.updatedAt
  const at = agent?.at ?? fallbackAt
  if (task.status === 'done')
    return { group: 'done', kind: 'done', reason: 'Completed', at: task.doneAt ?? fallbackAt }
  if (agent?.state === 'working') {
    return { group: 'running', kind: 'running', reason: agent.lastMessage ?? 'Working…', at }
  }
  if (agent?.state === 'waiting') {
    return {
      group: 'needs',
      kind: 'waiting',
      reason: agent.lastMessage ?? 'Waiting on you',
      at
    }
  }
  if (task.readiness === 'needs_spec') {
    return {
      group: 'needs',
      kind: 'spec',
      reason: 'Needs a spec before an agent can pick it up.',
      at: fallbackAt
    }
  }
  if (awaitsReview(task, agent?.state)) {
    return {
      group: 'needs',
      kind: 'review',
      reason: agent?.lastMessage ?? 'Idle — ready for your review.',
      at
    }
  }
  if (blockers.length > 0) {
    return {
      group: 'next',
      kind: 'blocked',
      blockers: [...blockers],
      reason: `Blocked by ${blockers.join(', ')}`,
      at: fallbackAt
    }
  }
  if (queuedAt !== undefined) {
    return {
      group: 'next',
      kind: 'queued',
      reason: `Queued #${queuedAt} for Dispatch`,
      at: fallbackAt
    }
  }
  if (agent?.state === 'idle') {
    return {
      group: 'next',
      kind: 'finished',
      reason: agent.lastMessage ?? 'Agent finished its turn.',
      at
    }
  }
  if (task.agentSession) {
    return { group: 'next', kind: 'resumable', reason: 'Session ended — can be resumed', at }
  }
  return { group: 'next', kind: 'idle', reason: 'No agent assigned', at: fallbackAt }
}

/** Most urgent first within a group: waiting agents, then the most recent activity. */
function compareItems(a: InboxItem, b: InboxItem): number {
  const rank = (item: InboxItem): number =>
    item.kind === 'waiting' ? 0 : item.kind === 'blocked' ? 2 : 1
  return rank(a) - rank(b) || b.at.localeCompare(a.at)
}

/**
 * Every group, in display order, including the empty ones. Archived tasks are left out, as on the
 * board. `queued` maps a task id to its place in the Orchestrate queue. `all` is every task in the
 * workspace, which blockers are looked up in; the board may be showing fewer (the Done cap), and a
 * blocker hidden from it is still a blocker.
 */
export function buildInbox(
  tasks: Task[],
  agents: ReadonlyMap<string, AgentStatus>,
  queued: ReadonlyMap<string, number> = new Map(),
  all: readonly Task[] = tasks
): Record<InboxGroup, InboxItem[]> {
  const groups: Record<InboxGroup, InboxItem[]> = { needs: [], running: [], next: [], done: [] }
  const byId = indexTasks(all)
  for (const task of tasks) {
    if (task.archivedAt && task.status !== 'done') continue
    if (isAgentArchived(task) && task.status !== 'done') continue
    const agent = agents.get(task.id)
    const queuedAt = queued.get(task.id)
    const blockers = openBlockers(task, byId).map((blocker) => blocker.id)
    const verdict = classifyTask(task, agent, queuedAt, blockers)
    groups[verdict.group].push({ task, agent, queuedAt, ...verdict })
  }
  // The board already hides archived Done tasks; keep that here too.
  groups.done = groups.done.filter((item) => !item.task.archivedAt)
  for (const group of INBOX_GROUPS) groups[group].sort(compareItems)
  return groups
}

/** The group sizes the workspace switcher shows, with "Needs you" split by why. */
export function summariseInbox(groups: Record<InboxGroup, InboxItem[]>): WorkspaceBoardSummary {
  const needsOfKind = (kind: InboxKind): number =>
    groups.needs.filter((item) => item.kind === kind).length
  return {
    needs: groups.needs.length,
    running: groups.running.length,
    next: groups.next.length,
    waiting: needsOfKind('waiting'),
    review: needsOfKind('review'),
    spec: needsOfKind('spec')
  }
}
