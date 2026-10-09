import type { ReactNode } from 'react'
import { isDispatchLive, type DispatchButtonState } from '../../lib/orchestrateHint.js'
import { Button } from '../ui.js'

/** The header's Dispatch button: what it would start, a run in progress, Auto-run, or paused. */
export function DispatchButton({
  state,
  disabled,
  onClick
}: {
  state: DispatchButtonState
  disabled: boolean
  onClick: () => void
}): ReactNode {
  const live = isDispatchLive(state)
  return (
    <Button
      onClick={onClick}
      disabled={disabled}
      title={state.title}
      className={live ? 'dispatch-running disabled:opacity-100' : ''}
    >
      {live ? (
        <span
          aria-hidden
          className="size-[7px] shrink-0 animate-pulse rounded-full bg-[var(--color-accent-text)]"
        />
      ) : state.mode === 'paused' ? (
        <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-danger" />
      ) : (
        <svg
          width="13"
          height="13"
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
        </svg>
      )}
      {state.label}
      {state.badge > 0 ? (
        <span className="inline-flex h-[18px] items-center rounded-md bg-accent/20 px-1.5 font-mono text-[10.5px] font-semibold text-[var(--color-accent-text)]">
          {state.mode === 'auto' ? `${state.badge} running` : state.badge}
        </span>
      ) : null}
    </Button>
  )
}
