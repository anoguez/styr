import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommentAnchor } from '@core/review.js'
import { plural } from '@core/review.js'
import {
  AGENT_PROVIDER_SHORT_LABELS,
  type ReviewComment,
  type ReviewSent,
  type TaskReview
} from '@core/types.js'
import { ipcMessage } from '../lib/ipcMessage.js'

/** The comment being written or edited: one at a time, across every file of the dialog. */
export interface ReviewDraft {
  anchor: CommentAnchor
  body: string
  /** The comment being edited; unset for a new one. */
  editId?: string
}

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  }
}

/** The Sent note in the footer, from what `requestChanges` reported. */
export function sentNote(sent: ReviewSent): string {
  const agent = AGENT_PROVIDER_SHORT_LABELS[sent.provider]
  const moved = sent.movedToInProgress ? ' · task moved to In progress' : ''
  return `Sent ${plural(sent.count, 'comment')} to ${agent}${moved}`
}

/**
 * A task's review comments for the Changes dialog: loaded from the host, changed optimistically
 * and saved whole (last write wins). A failed save keeps the local state and says so; the open
 * composer's draft lives here too, so it survives switching files.
 */
export function useTaskReview(taskId: string) {
  const [review, setReview] = useState<TaskReview>({ taskId, pending: [] })
  const [saveError, setSaveError] = useState<string>()
  const [sent, setSent] = useState<ReviewSent>()
  const [draft, setDraft] = useState<ReviewDraft | null>(null)
  const latest = useRef(review)
  latest.current = review

  const load = useCallback(() => {
    void window.api.review.get(taskId).then(
      (next) => setReview(next),
      (error: unknown) => setSaveError(ipcMessage(error))
    )
  }, [taskId])

  useEffect(load, [load])
  useEffect(
    () => window.api.review.onChanged((event) => event.taskId === taskId && load()),
    [taskId, load]
  )

  const commit = useCallback(
    (pending: ReviewComment[]) => {
      setReview((current) => ({ ...current, pending }))
      void window.api.review.save(taskId, pending).then(
        () => setSaveError(undefined),
        (error: unknown) => setSaveError(`Couldn’t save the comments: ${ipcMessage(error)}`)
      )
    },
    [taskId]
  )

  /** Adds the draft as a new comment, or saves the edit; nothing for a blank body. */
  const saveDraft = useCallback((): boolean => {
    if (!draft) return false
    const body = draft.body.trim()
    if (!body) return false
    const pending = latest.current.pending
    if (draft.editId) {
      commit(pending.map((c) => (c.id === draft.editId ? { ...c, body } : c)))
    } else {
      const comment: ReviewComment = {
        ...draft.anchor,
        id: newId(),
        body,
        createdAt: new Date().toISOString()
      }
      commit([...pending, comment])
      setSent(undefined)
    }
    setDraft(null)
    return true
  }, [draft, commit])

  const remove = useCallback(
    (id: string) => {
      commit(latest.current.pending.filter((comment) => comment.id !== id))
      setDraft((current) => (current?.editId === id ? null : current))
    },
    [commit]
  )

  /**
   * Opens the composer, replacing any open one; asks first when that one has unsaved text (warn,
   * don't refuse). False when the person kept the open one.
   */
  const openDraft = useCallback(
    (next: ReviewDraft): boolean => {
      if (draft && draft.body.trim() && draft.body !== next.body) {
        if (!window.confirm('Discard the comment you are writing?')) return false
      }
      setDraft(next)
      return true
    },
    [draft]
  )

  /** Sends the pending comments; throws the host's error for the sheet to show. */
  const requestChanges = useCallback(
    async (summary: string): Promise<ReviewSent> => {
      const result = await window.api.review.requestChanges(taskId, summary)
      setSent(result)
      load()
      return result
    },
    [taskId, load]
  )

  return {
    review,
    pending: review.pending,
    saveError,
    sent,
    draft,
    setDraft,
    openDraft,
    saveDraft,
    remove,
    requestChanges
  }
}

export type TaskReviewState = ReturnType<typeof useTaskReview>
