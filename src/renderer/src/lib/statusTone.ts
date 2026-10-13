import type { TaskStatus } from '@core/types.js'

/** One dot colour per board column, shared by the Inbox and the terminal's context bar. */
export const STATUS_DOT: Record<TaskStatus, string> = {
  backlog: 'bg-[var(--color-col-backlog)]',
  in_progress: 'bg-[var(--color-col-progress)]',
  in_review: 'bg-[var(--color-col-review)]',
  done: 'bg-[var(--color-col-done)]'
}
