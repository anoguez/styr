import type { ReactNode } from 'react'
import { currentWindow, type ProviderUsage } from '@core/usage.js'

/** The Claude 5-hour window as a small bar for a terminal's context bar. Nothing until the usage mod has written a reading. */
export function UsageMeter({ usage }: { usage: ProviderUsage | null }): ReactNode {
  const window5h = currentWindow(usage, 'five_hour', Date.now())
  if (!window5h) return null
  const percent = Math.min(100, Math.max(0, Math.round(window5h.percentUsed)))
  const resets = window5h.resetsAt
    ? ` Resets ${new Date(window5h.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
    : ''
  const tone =
    percent >= 90 ? 'bg-danger' : percent >= 70 ? 'bg-[var(--color-col-review)]' : 'bg-accent'
  return (
    <span
      className="flex items-center gap-1.5 px-2.5 text-[11px] text-faint"
      title={`Claude 5-hour usage: ${percent}%.${resets}`}
    >
      <span>5h</span>
      <span className="h-1 w-12 overflow-hidden rounded-full bg-raised">
        <span className={`block h-full ${tone}`} style={{ width: `${percent}%` }} />
      </span>
      <span className="font-mono text-[10px]">{percent}%</span>
    </span>
  )
}
