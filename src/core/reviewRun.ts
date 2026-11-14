import type { AgentStatus } from './agentState.js'
import type { Task } from './types.js'

/** Marks the throwaway task behind Ask to review (`reviewDraft`); it is archived when the review ends. */
export const REVIEW_RUN_TAG = 'review-run'

export function isReviewRun(task: { tags: readonly string[] }): boolean {
  return task.tags.includes(REVIEW_RUN_TAG)
}

/**
 * The task a review run reviews: the other task whose history holds the run's chat. Derived from the
 * files, so nothing links the two but the chat itself.
 */
export function reviewedTask(run: Task, tasks: readonly Task[]): Task | undefined {
  const chat = run.agentSession?.id
  if (!chat) return undefined
  return tasks.find(
    (task) => task.id !== run.id && task.sessions.some((entry) => entry.id === chat)
  )
}

/**
 * Review runs whose review is done: the reviewer has stopped (its turn ended) and the task it
 * reviews has left In Review, passed or sent back. Their terminals are closed, which archives them.
 * Runs on every agent change. `fresh` re-reads a reviewed task, since the reviewer's status write
 * can reach the file before the index.
 */
export function finishedReviewRuns(
  tasks: readonly Task[],
  statuses: readonly AgentStatus[],
  fresh: (task: Task) => Task = (task) => task
): Task[] {
  const runs = tasks.filter((task) => isReviewRun(task) && !task.archivedAt)
  if (runs.length === 0) return []
  return runs.filter((run) => {
    const state = statuses.find((status) => status.taskId === run.id)?.state
    if (state !== 'idle') return false
    const reviewed = reviewedTask(run, tasks)
    return reviewed !== undefined && fresh(reviewed).status !== 'in_review'
  })
}
