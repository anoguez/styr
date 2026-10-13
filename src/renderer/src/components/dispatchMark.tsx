import type { ReactNode } from 'react'
import type { Task } from '@core/types.js'

/** Dispatch's paper plane; struck through when Dispatch may not start the task. */
export function DispatchGlyph({
  off = false,
  size = 10
}: {
  off?: boolean
  size?: number
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M13.5 2.5 2.5 7l4.5 2 2 4.5z" />
      <path d="M13.5 2.5 7 9" />
      {off ? <path d="M2 2l12 12" /> : null}
    </svg>
  )
}

/** Hover and menu wording for the per-task Dispatch switch. */
export function dispatchToggleTitle(task: Task): string {
  return task.orchestrate
    ? `Dispatch can start ${task.id} — click so only you can start it`
    : `Only you can start ${task.id} — click to let Dispatch start it`
}
