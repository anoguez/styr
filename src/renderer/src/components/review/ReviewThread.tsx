import type { ReactNode } from 'react'
import { commentRef } from '@core/review.js'
import type { ReviewComment } from '@core/types.js'
import { Glyph } from '../changesParts.js'
import { Chip } from '../ui.js'

/** A comment as one line's thread draws it: pending ones can be edited, sent ones are history. */
export interface ThreadComment {
  comment: ReviewComment
  sent: boolean
}

const iconButton =
  'inline-flex size-6 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-ink'

export function ReviewCommentCard({
  item,
  onEdit,
  onDelete,
  showText = false
}: {
  item: ThreadComment
  onEdit?: () => void
  onDelete?: () => void
  /** Show the stored line text too, where the line itself is not drawn (outdated comments). */
  showText?: boolean
}): ReactNode {
  const { comment, sent } = item
  return (
    <div
      className="flex max-w-[680px] flex-col gap-[5px] rounded-[10px] border border-edge-strong bg-panel pb-2.5 pl-3 pr-2 pt-[9px]"
      style={{ opacity: sent ? 0.75 : 1 }}
    >
      <div className="flex min-h-[22px] items-center gap-2">
        <span className="text-[12px] font-semibold text-ink">You</span>
        <span className="font-mono text-[10.5px] text-faint">{commentRef(comment)}</span>
        <Chip tone={sent ? 'done' : 'warn'}>{sent ? 'Sent' : 'Pending'}</Chip>
        <span className="flex-1" />
        {!sent && onEdit ? (
          <button
            type="button"
            aria-label="Edit comment"
            title="Edit"
            className={iconButton}
            onClick={onEdit}
          >
            <Glyph name="edit" />
          </button>
        ) : null}
        {!sent && onDelete ? (
          <button
            type="button"
            aria-label="Delete comment"
            title="Delete"
            className={`${iconButton} hover:text-danger`}
            onClick={onDelete}
          >
            <Glyph name="trash" />
          </button>
        ) : null}
      </div>
      {showText && comment.text.trim() ? (
        <code
          className="truncate text-[11px] text-faint"
          style={{ fontFamily: 'var(--font-terminal)' }}
        >
          {comment.text.trim()}
        </code>
      ) : null}
      <p className="m-0 whitespace-pre-wrap pr-1 text-[12.5px] text-ink [text-wrap:pretty]">
        {comment.body}
      </p>
    </div>
  )
}

/**
 * The block under a diff line: its comments in creation order, then the composer when it is open
 * there. Pinned to the visible width, so it does not scroll sideways with long lines.
 */
export function ReviewThread({
  items,
  composer,
  onEdit,
  onDelete
}: {
  items: ThreadComment[]
  composer?: ReactNode
  onEdit: (comment: ReviewComment) => void
  onDelete: (comment: ReviewComment) => void
}): ReactNode {
  return (
    <div
      className="sticky left-0 z-[2] box-border flex w-[100cqw] flex-col gap-2 border-y border-edge bg-chrome pb-2.5 pl-[112px] pr-4 pt-2 leading-normal"
      style={{ fontFamily: 'var(--font-ui)' }}
    >
      {items.map((item) => (
        <ReviewCommentCard
          key={item.comment.id}
          item={item}
          onEdit={() => onEdit(item.comment)}
          onDelete={() => onDelete(item.comment)}
        />
      ))}
      {composer}
    </div>
  )
}
