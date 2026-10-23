import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AnswerResult } from '@core/types.js'
import { Glyph } from '../changesParts.js'

const SHOW_MS = 8000

/** What the toast says about an answer. Pure, for the test. */
export function answerToastText(result: AnswerResult): { title: string; body: string } {
  const id = result.task.id
  switch (result.delivery) {
    case 'queued':
      return { title: `Answer saved for ${id}`, body: 'The agent gets it the next time it stops.' }
    case 'now':
      return { title: `Answer sent for ${id}`, body: 'Delivered to its session.' }
    case 'resume':
      return { title: `Answer sent for ${id}`, body: 'Its chat resumed with your answer.' }
    case 'recorded':
      return {
        title: `Answer saved for ${id}`,
        body: 'There is no chat to send it to; the agent will see it on its next launch.'
      }
    case 'failed':
      return {
        title: `Answer saved for ${id}, but not delivered`,
        body: `${result.error ?? 'The agent could not be reached.'} It will see the answer on its next launch.`
      }
  }
}

/** Confirms an answer after the field is gone. It leaves after `SHOW_MS`, never while hovered. */
export function AnswerSentToast({
  result,
  onDismiss
}: {
  result: AnswerResult
  onDismiss: () => void
}): ReactNode {
  const [hovered, setHovered] = useState(false)
  const latest = useRef(onDismiss)
  latest.current = onDismiss
  const { title, body } = answerToastText(result)
  const failed = result.delivery === 'failed'

  useEffect(() => {
    if (hovered) return
    const timer = window.setTimeout(() => latest.current(), SHOW_MS)
    return () => window.clearTimeout(timer)
  }, [hovered, result])

  return (
    <div
      role="status"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="fixed bottom-12 right-5 z-[60] box-border flex w-[min(400px,calc(100vw-32px))] items-start gap-[11px] rounded-xl border border-edge-strong bg-panel py-3 pl-3.5 pr-2 text-ink shadow-[0_18px_44px_-12px_rgba(0,0,0,0.75)]"
    >
      <span
        className={`mt-px grid size-[22px] shrink-0 place-items-center rounded-full ${
          failed
            ? 'bg-danger/15 text-danger'
            : 'bg-[var(--color-col-done)]/18 text-[var(--color-col-done-text)]'
        }`}
      >
        <Glyph name={failed ? 'close' : 'check'} size={12} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="text-[12px] leading-[1.45] text-dim [text-wrap:pretty]">{body}</span>
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
