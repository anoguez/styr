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

/** One suggested timesheet entry: hours to log against a task on a day (`YYYY-MM-DD`). */
export interface WorklogSuggestion {
  day: string
  taskId: string
  hours: number
  /** What the hours went on, in a few words. */
  note?: string
}

/** A day's suggested entries, as written to `<workspace>/worklog/<day>.json`. */
export interface WorklogDaySuggestions {
  day: string
  generatedAt: string
  entries: Omit<WorklogSuggestion, 'day'>[]
}

/** What the Worklog loads for a span: the measured time and any suggested days in it. */
export interface WorklogData {
  tasks: WorklogTask[]
  suggestions: WorklogDaySuggestions[]
}
