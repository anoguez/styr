import type { AgentState, AgentStatus } from '@core/agentState.js'
import { sortColumn } from '@core/boardOrder.js'
import type { OrchestrationLane, OrchestrationSummary, Task, TaskStatus } from '@core/types.js'

export type Board = Record<TaskStatus, Task[]>

/** Done keeps its recency order; the other columns sort by priority, then working agents. */
export function sortBoard(board: Board, agents: ReadonlyMap<string, AgentStatus>): Board {
  const state = (id: string): AgentState | undefined => agents.get(id)?.state
  return {
    ...board,
    backlog: sortColumn(board.backlog, state),
    in_progress: sortColumn(board.in_progress, state),
    in_review: sortColumn(board.in_review, state)
  }
}

/** Every task on the board, column by column. */
export function boardTasks(board: Board): Task[] {
  return Object.values(board).flat()
}

/** What a terminal tab needs to know of its task: the title to show, and status and PR link. */
export function taskSummaries(tasks: Task[]): {
  titles: Map<string, string>
  states: Map<string, { status: TaskStatus; prUrl?: string }>
} {
  return {
    titles: new Map(tasks.map((task) => [task.id, task.title])),
    states: new Map(tasks.map((task) => [task.id, { status: task.status, prUrl: task.prUrl }]))
  }
}

/** Where each task waits in the next Dispatch run (1-based), and the lane that would start it. */
export function dispatchQueue(
  orchestration: OrchestrationSummary | null
): Map<string, { position: number; lane: OrchestrationLane }> {
  return new Map(
    (orchestration?.dispatch ?? []).map((entry, index) => [
      entry.taskId,
      { position: index + 1, lane: entry.lane }
    ])
  )
}
