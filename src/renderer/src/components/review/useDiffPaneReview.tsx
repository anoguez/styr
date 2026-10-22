import { useMemo, type ReactNode } from 'react'
import type { DiffRow } from '@core/diffView.js'
import { commentAnchor, commentRef, plural } from '@core/review.js'
import type { ReviewComment } from '@core/types.js'
import type { TaskReviewState } from '../../hooks/useTaskReview.js'
import { reviewLayout } from '../../lib/reviewLayout.js'
import type { DiffPaneReview } from '../DiffPane.js'
import { CommentComposer } from './CommentComposer.js'
import { sentTime } from './ReviewCommentList.js'
import { ReviewCommentCard, ReviewThread } from './ReviewThread.js'

/**
 * What `DiffPane` needs to draw one file's review: the layout of its comments over the rows, the
 * composer, and the outdated comments above the rows. Undefined where the file takes no comments.
 */
export function useDiffPaneReview(
  state: TaskReviewState,
  path: string | undefined,
  rows: DiffRow[],
  enabled: boolean,
  /** The comment the Comments tab jumped to, outlined. */
  focusId?: string
): DiffPaneReview | undefined {
  const { review, draft, setDraft, openDraft, saveDraft, remove } = state
  const layout = useMemo(
    () => (path && enabled ? reviewLayout(rows, path, review, draft) : undefined),
    [rows, path, review, draft, enabled]
  )
  if (!layout || !path) return undefined

  const edit = (comment: ReviewComment): void => {
    openDraft({
      anchor: { path, side: comment.side, line: comment.line, text: comment.text },
      body: comment.body,
      editId: comment.id
    })
  }

  const composer = (outdated: boolean): ReactNode =>
    draft ? (
      <CommentComposer
        refLabel={commentRef(draft.anchor)}
        body={draft.body}
        editing={Boolean(draft.editId)}
        outdated={outdated}
        onChange={(body) => setDraft({ ...draft, body })}
        onSave={saveDraft}
        onCancel={() => setDraft(null)}
      />
    ) : null

  const top =
    layout.outdated.length > 0 || layout.draftRow === 'top' ? (
      <div
        className="sticky left-0 z-[2] box-border flex w-[100cqw] flex-col gap-2 border-b border-edge bg-[color-mix(in_oklab,var(--color-raised)_35%,var(--color-chrome))] px-4 pb-3 pt-2.5 leading-normal"
        style={{ fontFamily: 'var(--font-ui)' }}
      >
        {layout.draftRow === 'top' ? composer(true) : null}
        {layout.outdated.length > 0 ? (
          <>
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11.5px] text-dim">
              <span className="font-semibold text-ink">
                {plural(layout.outdated.length, 'outdated comment')}
              </span>
              The line changed after you commented, so it’s pinned here.
            </span>
            {layout.outdated.map((comment) => (
              <ReviewCommentCard
                key={comment.id}
                item={{ comment, sent: false }}
                outdated
                focused={focusId === comment.id}
                onDelete={() => remove(comment.id)}
              />
            ))}
          </>
        ) : null}
      </div>
    ) : null

  return {
    layout,
    top,
    onComment: (index) => {
      const row = rows[index]
      const anchor = row ? commentAnchor(row, path) : null
      if (anchor) openDraft({ anchor, body: '' })
    },
    renderThread: (index) => {
      const items = layout.threads.get(index) ?? []
      const open = layout.draftRow === index
      if (items.length === 0 && !open) return null
      return (
        <ReviewThread
          items={items}
          sentAt={review.lastSent ? sentTime(review.lastSent.at) : undefined}
          focusId={focusId}
          composer={open ? composer(false) : undefined}
          onEdit={edit}
          onDelete={(comment) => remove(comment.id)}
        />
      )
    }
  }
}
