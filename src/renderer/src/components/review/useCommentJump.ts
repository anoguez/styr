import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ReviewComment, TaskReview } from '@core/types.js'
import { orderedComments } from './ReviewCommentList.js'

/**
 * Jumping to a review comment from the Comments tab or the Request changes sheet: open its file,
 * scroll the diff so the comment sits near the top third, and pulse its outline once (not with
 * reduced motion). The comment stays focused; `step` walks to the next one, across files.
 */
export function useCommentJump({
  region,
  review,
  openFile,
  expand
}: {
  /** The diff's scroll region. */
  region: RefObject<HTMLDivElement | null>
  review: TaskReview
  openFile: (path: string) => void
  /**
   * Asked when the comment is not drawn once its file's patch is in: loads the whole file, so a
   * comment inside a fold shows. False when there is nothing more to load.
   */
  expand: (path: string) => boolean
}) {
  const [focus, setFocus] = useState<{ id: string; path: string; seq: number }>()
  const done = useRef(0)
  const expanded = useRef(0)

  const go = (comment: ReviewComment): void => {
    openFile(comment.path)
    setFocus((last) => ({ id: comment.id, path: comment.path, seq: (last?.seq ?? 0) + 1 }))
  }

  const step = (by: 1 | -1): void => {
    const list = orderedComments(review)
    if (list.length === 0) return
    const at = list.findIndex((item) => item.comment.id === focus?.id)
    const next = at < 0 ? (by > 0 ? 0 : list.length - 1) : at + by
    const item = list[Math.min(list.length - 1, Math.max(0, next))]
    if (item) go(item.comment)
  }

  // Each render until the comment is on screen: its file's patch may still be loading.
  useEffect(() => {
    if (!focus || done.current === focus.seq) return
    const scroller = region.current
    const card = scroller?.querySelector<HTMLElement>(`[data-cmt-id="${CSS.escape(focus.id)}"]`)
    if (!scroller || !card) {
      if (expanded.current !== focus.seq && expand(focus.path)) expanded.current = focus.seq
      return
    }
    done.current = focus.seq
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const top =
      scroller.scrollTop +
      card.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      Math.min(140, scroller.clientHeight / 4)
    scroller.scrollTo({ top: Math.max(0, top), behavior: still ? 'auto' : 'smooth' })
    if (!still) {
      card.animate(
        [
          { boxShadow: '0 0 0 7px color-mix(in oklab, var(--color-accent-text) 45%, transparent)' },
          { boxShadow: '0 0 0 3px color-mix(in oklab, var(--color-accent-text) 0%, transparent)' }
        ],
        { duration: 1100, easing: 'ease-out' }
      )
    }
  })

  return { focusId: focus?.id, go, step }
}
