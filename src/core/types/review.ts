import type { TerminalSessionInfo } from './terminal.js'

/**
 * Review comments on a task's diff (the Changes dialog's "Request changes"). Draft UI state, kept
 * per task in `<workspace>/.styr/reviews/<TASK-id>.json`: not task data, not in the index.
 */

/** Which side of the diff a comment's line number counts on: `old` only for deleted rows. */
export type ReviewSide = 'new' | 'old'

export interface ReviewComment {
  id: string
  /** Repo-relative; the new path for a renamed file. */
  path: string
  side: ReviewSide
  /** New-side number for added and context rows, old-side for deleted ones. */
  line: number
  /** The line's content when commented, for re-anchoring and the message. */
  text: string
  body: string
  /** ISO time. */
  createdAt: string
}

export interface ReviewBatch {
  at: string
  comments: ReviewComment[]
  summary?: string
}

export interface TaskReview {
  taskId: string
  pending: ReviewComment[]
  /** The last batch sent to the agent, drawn read-only where it still places. */
  lastSent?: ReviewBatch
}

/**
 * How Request changes reaches the task's agent:
 * - `queued`: a live terminal whose agent is working; it takes the prompt at its next stop.
 * - `now`: a live terminal whose agent waits for input.
 * - `resume`: no live agent, but the task has a chat to resume with the review as its prompt.
 * - `fresh`: no chat; a new launch with the review before the task's prompt.
 */
export type ReviewRoute = 'queued' | 'now' | 'resume' | 'fresh'

/** What the review message says it is measured against. */
export type ReviewTarget =
  { kind: 'branch'; branch: string; base: string } | { kind: 'repo'; repoName: string }

/** What the Request changes sheet shows before sending, as the host would send it. */
export interface ReviewPreparation {
  route: ReviewRoute
  provider: 'claude' | 'codex'
  target: ReviewTarget
  /** Ids of pending comments that no longer place on the current diff. */
  outdated: string[]
}

/** What `review:requestChanges` did. */
export interface ReviewSent {
  /** The terminal a resume or a fresh launch opened, for the renderer to show. */
  session?: TerminalSessionInfo
  route: ReviewRoute
  provider: 'claude' | 'codex'
  count: number
  files: number
  /** The task moved back to In progress. */
  movedToInProgress: boolean
}
