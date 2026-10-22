import { useMemo, type ReactNode } from 'react'
import type { DiffRow } from '@core/diffView.js'
import { commentAnchor, commentRef, plural } from '@core/review.js'
import type { ReviewComment } from '@core/types.js'
import type { TaskReviewState } from '../../hooks/useTaskReview.js'
import { reviewLayout } from '../../lib/reviewLayout.js'
import type { DiffPaneReview } from '../DiffPane.js'
import { CommentComposer } from './CommentComposer.js'
import { ReviewCommentCard, ReviewThread } from './ReviewThread.js'

/**
 * What `DiffPane` needs to draw one file's review: the layout of its comments over the rows, the
 * composer, and the outdated comments above the rows. Undefined where the file takes no comments.
 */
export function useDiffPaneReview(
  state: TaskReviewState,
  path: string | undefined,
  rows: DiffRow[],
  enabled: boolean
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
        className="sticky left-0 z-[2] box-border flex w-[100cqw] flex-col gap-2 border-b border-edge bg-chrome px-4 py-2.5"
        style={{ fontFamily: 'var(--font-ui)' }}
      >
        {layout.draftRow === 'top' ? composer(true) : null}
        {layout.outdated.length > 0 ? (
          <details className="flex flex-col gap-2" open>
            <summary className="cursor-pointer text-[11.5px] font-medium text-[var(--color-col-review-text)]">
              {plural(layout.outdated.length, 'outdated comment')}
              <span className="font-normal text-faint">
                {' '}
                · their lines changed; they are still sent
              </span>
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              {layout.outdated.map((comment) => (
                <ReviewCommentCard
                  key={comment.id}
                  item={{ comment, sent: false }}
                  showText
                  onDelete={() => remove(comment.id)}
                />
              ))}
            </div>
          </details>
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
          composer={open ? composer(false) : undefined}
          onEdit={edit}
          onDelete={(comment) => remove(comment.id)}
        />
      )
    }
  }
}
