import type { ReactNode } from 'react'
import { plural } from '@core/review.js'
import type { ReviewBatch } from '@core/types.js'
import { Glyph } from '../changesParts.js'
import { Button } from '../ui.js'
import { sentTime } from './ReviewCommentList.js'

/** The footer's "Click a line number to comment" hint, beside the dialog's key hints. */
export function ReviewHint(): ReactNode {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-dim">
        <Glyph name="comment" size={12} />
      </span>
      Click a line number to comment
    </span>
  )
}

/**
 * The right of the Changes dialog's footer: a failed save, the pending count (which opens the
 * Comments tab) or what was last sent, and Request changes. `active` is false in the whole-dialog
 * states and while loading, where only a failed save shows; the comments stay stored.
 */
export function ReviewFooter({
  active,
  pending,
  lastSent,
  saveError,
  onShowComments,
  onRequestChanges
}: {
  active: boolean
  pending: number
  lastSent?: ReviewBatch
  saveError?: string
  onShowComments: () => void
  onRequestChanges: () => void
}): ReactNode {
  const sentCount = lastSent?.comments.length ?? 0
  return (
    <>
      {saveError ? (
        <span role="alert" className="text-danger">
          {saveError}
        </span>
      ) : null}
      {active ? (
        <>
          {sentCount > 0 && pending === 0 && lastSent ? (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 text-[var(--color-col-done-text)]"
            >
              <Glyph name="check" size={12} />
              {plural(sentCount, 'comment')} sent {sentTime(lastSent.at)}
            </span>
          ) : null}
          <span aria-hidden className="h-4 w-px bg-edge" />
          <button
            type="button"
            title="Show comments"
            disabled={pending === 0 && sentCount === 0}
            onClick={onShowComments}
            className="inline-flex h-6 items-center gap-[5px] rounded-md px-1.5 text-dim hover:bg-raised/70 hover:text-ink disabled:pointer-events-none"
          >
            <Glyph name="comment" size={12} />
            {pending
              ? plural(pending, 'pending comment')
              : sentCount
                ? 'No pending comments'
                : 'No comments yet'}
          </button>
          {/* The title sits on a wrapper: a disabled button takes no pointer events. */}
          <span title={pending ? 'Send pending comments to the agent' : 'Add a comment first'}>
            <Button
              variant={pending ? 'primary' : 'ghost'}
              className="h-7 text-[12.5px]"
              disabled={pending === 0}
              onClick={onRequestChanges}
            >
              Request changes
            </Button>
          </span>
        </>
      ) : null}
    </>
  )
}
