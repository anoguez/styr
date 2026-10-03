import type { AgentState } from './agentState.js'
import { TASK_PRIORITIES, type Task } from './types.js'

/**
 * Display order of a board column: higher priority first, then tasks whose agent is working, then
 * the stored manual order. Nothing is written — `Task.order` stays the tie-break, so dragging still
 * orders tasks that are otherwise equal.
 */
export function sortColumn(
  tasks: Task[],
  agentState: (taskId: string) => AgentState | undefined
): Task[] {
  const rank = (task: Task): number => TASK_PRIORITIES.indexOf(task.priority)
  const working = (task: Task): number => (agentState(task.id) === 'working' ? 0 : 1)
  return [...tasks].sort(
    (a, b) =>
      rank(b) - rank(a) ||
      working(a) - working(b) ||
      a.order - b.order ||
      a.createdAt.localeCompare(b.createdAt)
  )
}
