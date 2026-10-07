import type { ReactNode } from 'react'
import { currentWindow, type ContextUsage, type ProviderUsage } from '@core/usage.js'

const WINDOWS = [
  { kind: 'five_hour', label: '5h', name: '5-hour', showDay: false },
  { kind: 'seven_day', label: '7d', name: '7-day', showDay: true }
] as const

const clamp = (percent: number): number => Math.min(100, Math.max(0, Math.round(percent)))

const kTokens = (tokens: number): string =>
  tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)

function resetText(resetsAt: string | undefined, showDay: boolean): string {
  if (!resetsAt) return ''
  const when = new Date(resetsAt).toLocaleString([], {
    ...(showDay ? { weekday: 'short' } : {}),
    hour: 'numeric',
    minute: '2-digit'
  })
  return `resets ${when}`
}

function Bar({ label, percent }: { label: string; percent: number }): ReactNode {
  const tone =
    percent >= 90 ? 'bg-danger' : percent >= 70 ? 'bg-[var(--color-col-review)]' : 'bg-accent'
  return (
    <span className="flex items-center gap-1.5">
      <span>{label}</span>
      <span className="h-1 w-12 overflow-hidden rounded-full bg-raised">
        <span className={`block h-full ${tone}`} style={{ width: `${percent}%` }} />
      </span>
      <span className="font-mono text-[10px]">{percent}%</span>
    </span>
  )
}

/**
 * This session's context fill, then Claude's account-wide rate-limit windows, as small bars for a
 * terminal's context bar. Each appears only once the usage mod has written a reading for it, and a
 * rate-limit window goes when its reset passes.
 */
export function UsageMeter({
  usage,
  context
}: {
  usage: ProviderUsage | null
  /** This session's own context window; the rate limits are the account's. */
  context: ContextUsage | null
}): ReactNode {
  const now = Date.now()
  const bars = WINDOWS.flatMap((spec) => {
    const found = currentWindow(usage, spec.kind, now)
    return found ? [{ spec, found }] : []
  })
  if (bars.length === 0 && !context) return null

  return (
    // The context bar is `pointer-events-none` so it never blocks the terminal; the meter opts back
    // in, or nothing under it could be hovered.
    <span className="group pointer-events-auto relative flex items-center gap-2.5 px-2.5 text-[11px] text-faint">
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-30 mb-1.5 hidden w-max flex-col gap-1 rounded-md border border-edge-strong bg-panel px-2.5 py-1.5 text-[11.5px] text-ink shadow-xl group-hover:flex"
      >
        {context ? (
          <span className="flex items-baseline gap-2">
            <span className="font-medium">Context</span>
            <span className="font-mono text-[10.5px]">{clamp(context.percent)}% used</span>
            {context.tokens !== undefined && context.window !== undefined ? (
              <span className="text-dim">
                {kTokens(context.tokens)} of {kTokens(context.window)} tokens
              </span>
            ) : null}
          </span>
        ) : null}
        {bars.map(({ spec, found }) => (
          <span key={spec.kind} className="flex items-baseline gap-2">
            <span className="font-medium">Claude {spec.name}</span>
            <span className="font-mono text-[10.5px]">{Math.round(found.percentUsed)}% used</span>
            <span className="text-dim">{resetText(found.resetsAt, spec.showDay)}</span>
          </span>
        ))}
      </span>
      {context ? <Bar label="ctx" percent={clamp(context.percent)} /> : null}
      {bars.map(({ spec, found }) => (
        <Bar key={spec.kind} label={spec.label} percent={clamp(found.percentUsed)} />
      ))}
    </span>
  )
}
