/**
 * One task's working time over a span, as the main process derives it from the task's own trail
 * (agent transcripts, activity notes, branch commits). Nothing here is stored: the Worklog asks for
 * a span and gets it recomputed.
 */
export interface WorklogTask {
  taskId: string
  title: string
  project?: string
  /** Stretches the task was being worked on, `[start, end]` in epoch ms, sorted and disjoint. */
  intervals: [number, number][]
}
