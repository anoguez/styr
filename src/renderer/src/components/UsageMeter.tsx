import type { ReactNode } from 'react'
import { currentWindow, type ProviderUsage } from '@core/usage.js'

const WINDOWS = [
  { kind: 'five_hour', label: '5h', name: '5-hour', showDay: false },
  { kind: 'seven_day', label: '7d', name: '7-day', showDay: true }
] as const

/**
 * Claude's rate-limit windows as small bars for a terminal's context bar. A window appears only
 * once the usage mod has written a reading for it, and goes when its reset passes.
 */
export function UsageMeter({ usage }: { usage: ProviderUsage | null }): ReactNode {
  const now = Date.now()
  const bars = WINDOWS.flatMap((spec) => {
    const found = currentWindow(usage, spec.kind, now)
    return found ? [{ spec, found }] : []
  })
  if (bars.length === 0) return null

  return (
    <span className="flex items-center gap-2.5 px-2.5 text-[11px] text-faint">
      {bars.map(({ spec, found }) => {
        const percent = Math.min(100, Math.max(0, Math.round(found.percentUsed)))
        const resets = found.resetsAt
          ? ` Resets ${new Date(found.resetsAt).toLocaleString([], {
              ...(spec.showDay ? { weekday: 'short' } : {}),
              hour: 'numeric',
              minute: '2-digit'
            })}.`
          : ''
        const tone =
          percent >= 90 ? 'bg-danger' : percent >= 70 ? 'bg-[var(--color-col-review)]' : 'bg-accent'
        return (
          <span
            key={spec.kind}
            className="flex items-center gap-1.5"
            title={`Claude ${spec.name} usage: ${percent}%.${resets}`}
          >
            <span>{spec.label}</span>
            <span className="h-1 w-12 overflow-hidden rounded-full bg-raised">
              <span className={`block h-full ${tone}`} style={{ width: `${percent}%` }} />
            </span>
            <span className="font-mono text-[10px]">{percent}%</span>
          </span>
        )
      })}
    </span>
  )
}
