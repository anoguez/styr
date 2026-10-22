import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { MAX_PROMPT_CHARS } from '@core/agentPrompt.js'
import { supportDir } from '@core/agentStore.js'
import type { DiffResult, PatchResult } from '@core/diff.js'
import { buildRows } from '@core/diffView.js'
import { groupComments, placeComments, plural, reviewMessage } from '@core/review.js'
import { loadSettings } from '@core/settingsStore.js'
import {
  REVIEW_LIMITS,
  TASK_ID_RE,
  reviewCommentsSchema,
  taskReviewSchema
} from '@core/taskSchema.js'
import type {
  ReviewComment,
  ReviewPreparation,
  ReviewRoute,
  ReviewSent,
  ReviewTarget,
  Task,
  TaskPatch,
  TaskReview,
  TerminalSessionInfo
} from '@core/types.js'
import type { HostPorts } from './ports.js'

/** Each task's review file, `<workspace>/.styr/reviews/<TASK-id>.json`. A test fakes it. */
export interface ReviewStore {
  /** The file's parsed JSON, or undefined when there is none. Throws on unreadable JSON. */
  read(taskId: string): unknown
  /** Replaces the file whole, atomically. */
  write(taskId: string, review: TaskReview): void
  remove(taskId: string): void
}

const reviewFile = (taskId: string): string =>
  join(supportDir(loadSettings(), 'reviews'), `${taskId}.json`)

export const diskReviewStore: ReviewStore = {
  read(taskId) {
    let text: string
    try {
      text = readFileSync(reviewFile(taskId), 'utf8')
    } catch {
      return undefined
    }
    return JSON.parse(text)
  },
  write(taskId, review) {
    const file = reviewFile(taskId)
    mkdirSync(join(file, '..'), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temp, `${JSON.stringify(review, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
  },
  remove(taskId) {
    rmSync(reviewFile(taskId), { force: true })
  }
}

export interface ReviewServicePorts extends Pick<HostPorts, 'broadcast'> {
  store: ReviewStore
  /** The active board's task, from the index. */
  findTask(taskId: string): Task | null | undefined
  /** The task's file, read in the workspace in force (for a pinned one, whose index is not open). */
  getTask(taskId: string): Task | null | undefined
  activeWorkspace(): string
  /** Runs synchronous writes with every path resolved in `workspaceId` (`inOtherWorkspace`). */
  pinWorkspace<T>(workspaceId: string, work: () => T): T
  updateTask(taskId: string, patch: TaskPatch): unknown
  addNote(taskId: string, author: string, message: string): unknown
  notifyTasks(): void
  /** The task's diff and one file's whole patch (`gitService`). */
  diff(taskId: string): DiffResult
  patch(taskId: string, path: string): PatchResult
  /** How the review would reach the agent, and the delivery (`sessionLifecycle`). */
  route(taskId: string): { route: ReviewRoute; provider: 'claude' | 'codex' }
  deliver(
    taskId: string,
    message: string
  ): Promise<{ route: ReviewRoute; provider: 'claude' | 'codex'; session?: TerminalSessionInfo }>
  now(): string
  warn(message: string): void
}

const taskIdSchema = z.string().regex(TASK_ID_RE, 'Not a task id')
const summarySchema = z.string().max(REVIEW_LIMITS.body)

/**
 * Review comments on a task's diff and Request changes (the Changes dialog). The comments are
 * draft UI state in one file per task, never task data. Requesting changes builds the message
 * from the stored pending comments, not from the caller's, delivers it to the task's agent, and
 * only then moves the comments to `lastSent`, the task back to In progress and writes a note.
 */
export function createReviewService(ports: ReviewServicePorts) {
  function read(taskId: string): TaskReview {
    const empty: TaskReview = { taskId, pending: [] }
    let raw: unknown
    try {
      raw = ports.store.read(taskId)
    } catch (error) {
      ports.warn(`Styr: the review of ${taskId} is unreadable and was ignored: ${String(error)}`)
      return empty
    }
    if (raw === undefined) return empty
    const parsed = taskReviewSchema.safeParse(raw)
    if (!parsed.success || parsed.data.taskId !== taskId) {
      ports.warn(`Styr: the review of ${taskId} is not valid and was ignored.`)
      return empty
    }
    return parsed.data
  }

  function get(taskId: unknown): TaskReview {
    return read(taskIdSchema.parse(taskId))
  }

  /** Replaces the pending comments (add, edit and delete all save the whole list). */
  function save(taskId: unknown, pending: unknown): TaskReview {
    const id = taskIdSchema.parse(taskId)
    const review: TaskReview = { ...read(id), pending: reviewCommentsSchema.parse(pending) }
    ports.store.write(id, review)
    return review
  }

  function target(task: Task, diff: DiffResult): ReviewTarget {
    if ('error' in diff) throw new Error(diff.error)
    if (diff.kind === 'repo') {
      return { kind: 'repo', repoName: basename(task.repoPath ?? '') || 'the repository' }
    }
    if (diff.kind !== 'changes') throw new Error('This task has no changes to review.')
    return { kind: 'branch', branch: diff.branch ?? task.id, base: diff.baseName }
  }

  /** The pending comments that no longer place on the task's current diff, by id. */
  function outdatedOf(taskId: string, diff: DiffResult, pending: ReviewComment[]): Set<string> {
    const files = new Set('error' in diff ? [] : diff.files.map((file) => file.path))
    const outdated = new Set<string>()
    for (const group of groupComments(pending)) {
      const patch = files.has(group.path) ? ports.patch(taskId, group.path) : undefined
      const rows = patch && 'patch' in patch ? buildRows(patch.patch) : undefined
      const placed = rows ? placeComments(rows, group.comments) : undefined
      for (const comment of group.comments) {
        if (!placed || placed.get(comment.id) === 'outdated') outdated.add(comment.id)
      }
    }
    return outdated
  }

  function prepareFor(taskId: string): {
    task: Task
    review: TaskReview
    preparation: ReviewPreparation
  } {
    const task = ports.findTask(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    const review = read(taskId)
    const diff = ports.diff(taskId)
    const preparation: ReviewPreparation = {
      ...ports.route(taskId),
      target: target(task, diff),
      outdated: [...outdatedOf(taskId, diff, review.pending)]
    }
    return { task, review, preparation }
  }

  /** What the Request changes sheet shows: the route, the target and the outdated comments. */
  function prepare(taskId: unknown): ReviewPreparation {
    return prepareFor(taskIdSchema.parse(taskId)).preparation
  }

  async function requestChanges(taskId: unknown, summary: unknown): Promise<ReviewSent> {
    const id = taskIdSchema.parse(taskId)
    const note = summarySchema.parse(summary ?? '')
    const prepared = prepareFor(id)
    const { review, preparation } = prepared
    const sent = review.pending
    if (sent.length === 0) throw new Error('There are no pending comments to send.')
    const message = reviewMessage(preparation.target, sent, note, new Set(preparation.outdated))
    if (message.length > MAX_PROMPT_CHARS) {
      throw new Error('Too long to send: shorten or remove comments.')
    }

    const workspaceId = ports.activeWorkspace()
    const statusBefore = prepared.task.status
    const delivered = await ports.deliver(id, message)
    const files = groupComments(sent).length
    const result: ReviewSent = { ...delivered, count: sent.length, files, movedToInProgress: false }

    // Delivered: only now does anything move. Comments added while it was sending stay pending.
    // The agent has the message, so a write that fails here is a warning, never a failed send
    // that would invite a second one.
    const active = ports.activeWorkspace() === workspaceId
    const settle = (): boolean => {
      const sentIds = new Set(sent.map((comment) => comment.id))
      ports.store.write(id, {
        taskId: id,
        pending: read(id).pending.filter((comment) => !sentIds.has(comment.id)),
        lastSent: {
          at: ports.now(),
          comments: sent,
          ...(note.trim() ? { summary: note.trim() } : {})
        }
      })
      // The active board reads the index; one switched away from while sending reads its file.
      const task = active ? ports.findTask(id) : ports.getTask(id)
      if (task?.status === 'in_review' || task?.status === 'done') {
        ports.updateTask(id, { status: 'in_progress' })
      }
      ports.addNote(
        id,
        'styr',
        `Requested changes: ${plural(sent.length, 'comment')} in ${plural(files, 'file')}`
      )
      // A launch moves a Backlog task itself; either way it is in progress now if it moved.
      return (
        statusBefore !== 'in_progress' &&
        (active ? ports.findTask(id) : ports.getTask(id))?.status !== statusBefore
      )
    }
    try {
      // The board may have switched while the agent took it: write to the one it was sent from.
      result.movedToInProgress = active ? settle() : ports.pinWorkspace(workspaceId, settle)
    } catch (error) {
      ports.warn(`Styr: sent the review of ${id} but could not record it: ${String(error)}`)
      result.warning = 'Sent, but Styr could not record it: the comments may still show as Pending.'
    }
    if (active) ports.notifyTasks()
    ports.broadcast('review:changed', { taskId: id })
    return result
  }

  /** Drops a deleted task's review. Never fails the delete. */
  function forget(taskId: string): void {
    try {
      ports.store.remove(taskId)
    } catch (error) {
      ports.warn(`Styr: could not remove the review of ${taskId}: ${String(error)}`)
    }
  }

  return { get, save, prepare, requestChanges, forget }
}

export type ReviewService = ReturnType<typeof createReviewService>
