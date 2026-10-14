export type WorklogPeriod = 'day' | 'week' | 'month'

/** One agent session's use on one local calendar day (`YYYY-MM-DD`). */
export interface WorklogSessionDay {
  day: string
  sessionId: string
  /** Tokens the session's turns used that day; 0 once its transcript is gone. */
  tokens: number
}

/**
 * One task's agent use over a span, as the main process reads it from the task's sessions'
 * transcripts. Nothing here is stored: the Worklog asks for a span and gets it recomputed.
 */
export interface WorklogTask {
  taskId: string
  title: string
  project?: string
  sessions: WorklogSessionDay[]
}

/** What the Worklog loads for a span. */
export interface WorklogData {
  tasks: WorklogTask[]
}
