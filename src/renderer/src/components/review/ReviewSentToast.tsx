import { useEffect, useRef, useState, type ReactNode } from 'react'
import { plural } from '@core/review.js'
import { AGENT_PROVIDER_SHORT_LABELS, type ReviewSent, type Task } from '@core/types.js'
import { Glyph } from '../changesParts.js'

/** How long the toast stays, longer while the pointer is on it. */
const SHOW_MS = 8000

const ROUTE_NOTE: Record<ReviewSent['route'], string> = {
  queued: 'Delivered the next time it waits for input.',
  now: 'Delivered to its session.',
  resume: 'Its session resumed in a terminal tab, now focused.',
  fresh: 'The agent started in a terminal tab, now focused.'
}

/** What the toast says about a send. Pure, for the test. */
export function sentToastText(sent: ReviewSent, taskId: string): { title: string; body: string } {
  const agent = AGENT_PROVIDER_SHORT_LABELS[sent.provider]
  const comments = plural(sent.count, 'comment')
  const moved = sent.movedToInProgress ? ` ${taskId} is back in In Progress.` : ''
  return {
    title:
      sent.route === 'queued' ? `Queued ${comments} for ${agent}` : `Sent ${comments} to ${agent}`,
    body: `${ROUTE_NOTE[sent.route]}${moved}`
  }
}

/**
 * Confirms Request changes after the Changes dialog closed: what was sent and where, with Show
 * terminal and Reopen changes. It leaves after `SHOW_MS`, never while hovered.
 */
export function ReviewSentToast({
  sent,
  task,
  onShowTerminal,
  onReopen,
  onDismiss
}: {
  sent: ReviewSent
  task: Task
  onShowTerminal: () => void
  onReopen: () => void
  onDismiss: () => void
}): ReactNode {
  const [hovered, setHovered] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const latest = useRef(onDismiss)
  latest.current = onDismiss
  const { title, body } = sentToastText(sent, task.id)

  useEffect(() => {
    if (hovered) return
    const timer = window.setTimeout(() => latest.current(), SHOW_MS)
    return () => window.clearTimeout(timer)
  }, [hovered, sent])

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    ref.current?.animate(
      [
        { opacity: 0, transform: 'translateY(12px) scale(0.98)' },
        { opacity: 1, transform: 'none' }
      ],
      { duration: 320, easing: 'cubic-bezier(.2,.7,.2,1)' }
    )
  }, [sent])

  const action =
    'inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-[7px] border px-[9px] text-[12px] font-medium'
  return (
    <div
      ref={ref}
      role="status"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="fixed bottom-12 right-5 z-[60] box-border flex w-[min(400px,calc(100vw-32px))] items-start gap-[11px] rounded-xl border border-edge-strong bg-panel py-3 pl-3.5 pr-2 text-ink shadow-[0_18px_44px_-12px_rgba(0,0,0,0.75)]"
    >
      <span className="mt-px grid size-[22px] shrink-0 place-items-center rounded-full bg-[var(--color-col-done)]/18 text-[var(--color-col-done-text)]">
        <Glyph name="check" size={12} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="text-[12px] leading-[1.45] text-dim [text-wrap:pretty]">{body}</span>
        <div className="mt-[7px] flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={onShowTerminal}
            className={`${action} border-edge-strong bg-raised/70 text-ink hover:bg-raised`}
          >
            <Glyph name="terminal" size={12} />
            Show terminal
          </button>
          <button
            type="button"
            onClick={onReopen}
            className={`${action} border-transparent text-dim hover:bg-raised hover:text-ink`}
          >
            <Glyph name="diff" size={12} />
            Reopen changes
          </button>
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-ink"
      >
        <Glyph name="close" size={12} />
      </button>
    </div>
  )
}
