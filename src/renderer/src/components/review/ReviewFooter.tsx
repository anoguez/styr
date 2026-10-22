import type { ReactNode } from 'react'
import { plural } from '@core/review.js'
import type { ReviewSent } from '@core/types.js'
import { sentNote } from '../../hooks/useTaskReview.js'
import { Glyph } from '../changesParts.js'
import { Button } from '../ui.js'

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
 * The right of the Changes dialog's footer: the last send's note, a failed save, the pending
 * count and Request changes. `active` is false in the whole-dialog states and while loading, where
 * only the notes show; the comments stay stored.
 */
export function ReviewFooter({
  active,
  pending,
  sent,
  saveError,
  onRequestChanges
}: {
  active: boolean
  pending: number
  sent?: ReviewSent
  saveError?: string
  onRequestChanges: () => void
}): ReactNode {
  return (
    <>
      {sent ? (
        <span
          role="status"
          className="inline-flex items-center gap-1.5 text-[var(--color-col-done-text)]"
        >
          <Glyph name="check" size={12} />
          {sentNote(sent)}
        </span>
      ) : null}
      {saveError ? (
        <span role="alert" className="text-danger">
          {saveError}
        </span>
      ) : null}
      {active ? (
        <>
          <span aria-hidden className="h-4 w-px bg-edge" />
          <span className="text-dim">
            {pending ? plural(pending, 'pending comment') : 'No comments yet'}
          </span>
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
