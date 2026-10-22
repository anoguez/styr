import { useState, type ReactNode } from 'react'
import { commentRef, groupComments } from '@core/review.js'
import type { ReviewComment, TaskReview } from '@core/types.js'
import { Glyph } from '../changesParts.js'

/** "14:20": when a batch was sent, in the person's clock. */
export function sentTime(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** The Comments tab's order: pending by path and line, then the last sent batch. */
export function orderedComments(review: TaskReview): { comment: ReviewComment; sent: boolean }[] {
  return [
    ...groupComments(review.pending).flatMap((group) =>
      group.comments.map((comment) => ({ comment, sent: false }))
    ),
    ...groupComments(review.lastSent?.comments ?? []).flatMap((group) =>
      group.comments.map((comment) => ({ comment, sent: true }))
    )
  ]
}

const matches = (comment: ReviewComment, needle: string): boolean =>
  !needle || `${comment.path} ${comment.body}`.toLowerCase().includes(needle)

function Groups({
  comments,
  sent,
  outdated,
  focusId,
  onGo
}: {
  comments: ReviewComment[]
  sent: boolean
  outdated: ReadonlySet<string>
  focusId?: string
  onGo: (comment: ReviewComment) => void
}): ReactNode {
  return groupComments(comments).map((group) => {
    const at = group.path.lastIndexOf('/')
    const [dir, name] =
      at < 0 ? ['', group.path] : [group.path.slice(0, at), group.path.slice(at + 1)]
    return (
      <div key={group.path} className="flex shrink-0 flex-col gap-px pt-1.5">
        <div
          title={group.path}
          className="flex h-6 items-center gap-1.5 overflow-hidden whitespace-nowrap px-2"
        >
          <span className="shrink-0 text-faint">
            <Glyph name="file" size={12} />
          </span>
          <span className="shrink-0 text-[12px] font-semibold text-ink">{name}</span>
          <span className="min-w-0 truncate text-[11px] text-faint">{dir}</span>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-faint">
            {group.comments.length}
          </span>
        </div>
        {group.comments.map((comment) => {
          const on = focusId === comment.id
          const stale = !sent && outdated.has(comment.id)
          return (
            <button
              key={comment.id}
              type="button"
              aria-current={on ? 'true' : undefined}
              title={`${comment.path}:${comment.line} — ${comment.body}`}
              onClick={() => onGo(comment)}
              className={`flex w-full flex-col gap-0.5 rounded-md border pb-1.5 pl-[26px] pr-2 pt-[5px] text-left hover:bg-raised ${on ? 'border-edge-strong bg-raised' : 'border-transparent'}`}
              style={{ opacity: sent ? 0.8 : 1 }}
            >
              <span className="flex min-h-4 items-center gap-1.5">
                <span
                  className={`font-mono text-[10.5px] ${stale ? 'text-faint' : 'text-[var(--color-accent-text)]'}`}
                >
                  {commentRef(comment)}
                </span>
                {stale ? (
                  <span className="inline-flex h-4 items-center rounded-[5px] bg-raised px-[5px] text-[10px] font-medium text-dim">
                    Outdated
                  </span>
                ) : null}
              </span>
              <span
                className={`block w-full truncate text-[12px] ${sent ? 'text-dim' : 'text-ink'}`}
              >
                {comment.body.split('\n')[0]}
              </span>
            </button>
          )
        })}
      </div>
    )
  })
}

/**
 * The Comments tab: every pending comment across files, grouped by file in path and line order,
 * then the last sent batch under "Sent 14:20" (collapsed once new comments exist). Clicking one
 * opens its file and scrolls to it.
 */
export function ReviewCommentList({
  review,
  outdated,
  query,
  focusId,
  onGo
}: {
  review: TaskReview
  outdated: ReadonlySet<string>
  query: string
  focusId?: string
  onGo: (comment: ReviewComment, sent: boolean) => void
}): ReactNode {
  const [sentOpen, setSentOpen] = useState<boolean>()
  const needle = query.trim().toLowerCase()
  const pending = review.pending.filter((comment) => matches(comment, needle))
  const sent = (review.lastSent?.comments ?? []).filter((comment) => matches(comment, needle))
  const open = sentOpen ?? review.pending.length === 0

  let empty: { title: string; body?: string } | undefined
  if (review.pending.length === 0 && !review.lastSent?.comments.length) {
    empty = {
      title: 'No comments yet',
      body: 'Click a line number in the diff to comment. Pending comments collect here so you can jump back to each one.'
    }
  } else if (needle && pending.length === 0 && sent.length === 0) {
    empty = { title: `No comments match “${query.trim()}”` }
  } else if (review.pending.length === 0) {
    empty = { title: 'Nothing pending', body: 'Comments you add now start a new batch.' }
  }

  return (
    <div
      role="list"
      aria-label="Comments"
      className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 pb-2 pt-0.5"
    >
      <Groups
        comments={pending}
        sent={false}
        outdated={outdated}
        focusId={focusId}
        onGo={(comment) => onGo(comment, false)}
      />
      {empty ? (
        <div className="flex shrink-0 flex-col items-center gap-1.5 px-[18px] pb-[18px] pt-7 text-center">
          <span className="mb-1 grid size-8 place-items-center rounded-[9px] border border-edge bg-panel text-faint">
            <Glyph name="comment" size={15} />
          </span>
          <span className="text-[12.5px] font-semibold text-ink">{empty.title}</span>
          {empty.body ? (
            <span className="text-[11.5px] leading-normal text-faint [text-wrap:pretty]">
              {empty.body}
            </span>
          ) : null}
        </div>
      ) : null}
      {review.lastSent && sent.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setSentOpen(!open)}
            className="mt-2 flex h-[30px] shrink-0 items-center gap-1.5 border-t border-edge px-2 text-left text-[11.5px] font-medium text-dim hover:text-ink"
          >
            <span className={`shrink-0 text-faint ${open ? '' : '-rotate-90'}`}>
              <Glyph name="chevron" size={11} />
            </span>
            <span className="inline-flex items-center gap-[5px] text-[var(--color-col-done-text)]">
              <Glyph name="check" size={11} />
              Sent {sentTime(review.lastSent.at)}
            </span>
            <span className="ml-auto font-mono text-[10.5px] text-faint">{sent.length}</span>
          </button>
          {open ? (
            <Groups
              comments={sent}
              sent
              outdated={outdated}
              focusId={focusId}
              onGo={(comment) => onGo(comment, true)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}
