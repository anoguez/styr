import type { DiffRow } from '@core/diffView.js'
import { placeComments, type CommentAnchor } from '@core/review.js'
import type { ReviewComment, TaskReview } from '@core/types.js'

export interface LayoutComment {
  comment: ReviewComment
  sent: boolean
}

/** Where one file's review comments and the open composer go on its diff rows. */
export interface ReviewLayout {
  /** Row index to the comments drawn under it, in creation order. */
  threads: Map<number, LayoutComment[]>
  /** Fold row index to how many comments it hides. */
  folded: Map<number, number>
  /** Pending comments of this file that no longer place. */
  outdated: ReviewComment[]
  /** Row the composer opens under; `top` when its line is gone from the diff. */
  draftRow?: number | 'top'
}

const byCreation = (a: LayoutComment, b: LayoutComment): number =>
  a.comment.createdAt.localeCompare(b.comment.createdAt)

/**
 * Lays one file's comments over its rows: pending ones where they place (or inside a fold, or
 * listed as outdated), the last sent batch only where it places exactly, and the composer under
 * its line. A comment being edited is drawn as the composer instead.
 */
export function reviewLayout(
  rows: DiffRow[],
  path: string,
  review: TaskReview,
  draft: { anchor: CommentAnchor; editId?: string } | null
): ReviewLayout {
  const threads = new Map<number, LayoutComment[]>()
  const folded = new Map<number, number>()
  const outdated: ReviewComment[] = []
  const add = (row: number, item: LayoutComment): void => {
    const list = threads.get(row) ?? []
    list.push(item)
    threads.set(row, list)
  }

  const pending = review.pending.filter((comment) => comment.path === path)
  const placed = placeComments(rows, pending)
  for (const comment of pending) {
    const at = placed.get(comment.id)
    if (!at || at === 'outdated') outdated.push(comment)
    else if (at.folded) folded.set(at.row, (folded.get(at.row) ?? 0) + 1)
    else if (comment.id !== draft?.editId) add(at.row, { comment, sent: false })
  }

  const sent = (review.lastSent?.comments ?? []).filter((comment) => comment.path === path)
  const sentAt = placeComments(rows, sent)
  for (const comment of sent) {
    const at = sentAt.get(comment.id)
    const row = at && at !== 'outdated' && !at.folded ? rows[at.row] : undefined
    const line =
      row && 'segments' in row ? (comment.side === 'old' ? row.oldLine : row.newLine) : undefined
    if (at && at !== 'outdated' && line === comment.line) add(at.row, { comment, sent: true })
  }
  for (const list of threads.values()) list.sort(byCreation)

  let draftRow: ReviewLayout['draftRow']
  if (draft && draft.anchor.path === path) {
    const probe = { ...draft.anchor, id: '', body: '', createdAt: '' }
    const at = placeComments(rows, [probe]).get('')
    draftRow = at && at !== 'outdated' && !at.folded ? at.row : 'top'
  }
  return { threads, folded, outdated, draftRow }
}

/** Pending comments per file, for the file list's counts. */
export function pendingByPath(review: TaskReview): Map<string, number> {
  const counts = new Map<string, number>()
  for (const comment of review.pending) {
    counts.set(comment.path, (counts.get(comment.path) ?? 0) + 1)
  }
  return counts
}
