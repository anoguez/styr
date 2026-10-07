import { useEffect, useRef, useState, type ReactNode } from 'react'
import { currentWindow, resetsIn, type ContextUsage, type ProviderUsage } from '@core/usage.js'

/** At and above these a bar stops being the accent and warns. */
const WARN = 75
const DANGER = 90

const clamp = (percent: number): number => Math.min(100, Math.max(0, Math.round(percent)))

const kTokens = (tokens: number): string =>
  tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)

const tone = (percent: number): { bar: string; text: string } =>
  percent >= DANGER
    ? { bar: 'bg-danger', text: 'text-danger' }
    : percent >= WARN
      ? { bar: 'bg-[var(--color-col-review)]', text: 'text-[var(--color-col-review)]' }
      : { bar: 'bg-accent', text: 'text-ink' }

interface Row {
  key: string
  /** Short form for the button. */
  short: string
  label: string
  percent: number
  sub: string
  isLimit: boolean
}

function rowsFor(usage: ProviderUsage | null, context: ContextUsage | null, now: number): Row[] {
  const rows: Row[] = []
  if (context) {
    rows.push({
      key: 'ctx',
      short: 'ctx',
      label: 'Context',
      percent: clamp(context.percent),
      sub:
        context.tokens !== undefined && context.window !== undefined
          ? `${kTokens(context.tokens)} of ${kTokens(context.window)} tokens · this session`
          : 'this session',
      isLimit: false
    })
  }
  const five = currentWindow(usage, 'five_hour', now)
  if (five) {
    const left = resetsIn(five.resetsAt, now)
    rows.push({
      key: '5h',
      short: '5h',
      label: '5-hour limit',
      percent: clamp(five.percentUsed),
      sub: left ? `Resets in ${left}` : '',
      isLimit: true
    })
  }
  const seven = currentWindow(usage, 'seven_day', now)
  if (seven) {
    const when = seven.resetsAt
      ? new Date(seven.resetsAt).toLocaleString([], {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit'
        })
      : ''
    rows.push({
      key: '7d',
      short: '7d',
      label: '7-day limit',
      percent: clamp(seven.percentUsed),
      sub: when ? `Resets ${when}` : '',
      isLimit: true
    })
  }
  return rows
}

/**
 * The terminal bar's usage control: a stack of thin meters and one label, opening a popover with
 * the detail. The label is the session's context unless a rate limit needs attention, so a glance
 * shows the number that matters. Context is this session's; the limits are the account's.
 * Renders nothing until the usage mod has written a reading.
 */
export function UsageButton({
  usage,
  context,
  agent,
  onCompact
}: {
  usage: ProviderUsage | null
  context: ContextUsage | null
  /** Sends `/compact` to the agent. */
  /** Whose numbers these are, for the popover's header. */
  agent: string
  onCompact: () => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement | null>(null)
  const popover = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!button.current?.contains(target) && !popover.current?.contains(target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const rows = rowsFor(usage, context, Date.now())
  if (rows.length === 0) return null

  const hot = rows
    .filter((row) => row.isLimit && row.percent >= WARN)
    .sort((a, b) => b.percent - a.percent)[0]
  const lead = hot ?? rows[0]!
  const title = rows.map((row) => `${row.short} ${row.percent}%`).join(' · ')
  const contextRow = rows.find((row) => row.key === 'ctx')

  return (
    // Positioned wrapper, so the popover opens over the button rather than the bar's far edge.
    <span className="relative inline-flex">
      <button
        ref={button}
        type="button"
        title={title}
        aria-label="Agent usage"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`pointer-events-auto inline-flex h-[22px] items-center gap-[7px] rounded-md border border-transparent px-[7px] font-mono text-[10.5px] hover:bg-raised/70 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent ${
          open ? 'bg-raised' : ''
        } ${lead.percent >= WARN ? tone(lead.percent).text : 'text-dim'}`}
      >
        <span aria-hidden className="grid w-[22px] gap-0.5">
          {rows.map((row) => (
            <span key={row.key} className="block h-0.5 overflow-hidden rounded-[1px] bg-edge">
              <span
                className={`block h-full ${tone(row.percent).bar}`}
                style={{ width: `${row.percent}%` }}
              />
            </span>
          ))}
        </span>
        <span className="hidden @md:inline">
          {lead.short} {lead.percent}%
        </span>
      </button>

      {open ? (
        <div
          ref={popover}
          role="dialog"
          aria-label="Agent usage"
          className="pointer-events-auto absolute bottom-full left-0 z-20 mb-1 flex w-[272px] flex-col overflow-hidden rounded-lg border border-edge-strong bg-panel shadow-2xl"
        >
          <div className="flex h-[30px] items-center gap-1.5 border-b border-edge px-2.5 text-[11.5px] text-dim">
            <span aria-hidden className="size-1.5 rounded-full bg-[var(--color-col-progress)]" />
            <span className="font-medium text-ink">{agent}</span>
            <span>· usage</span>
          </div>
          <div className="flex flex-col gap-2.5 p-2.5">
            {rows.map((row) => (
              <div key={row.key} className="flex flex-col gap-[5px]">
                <div className="flex items-baseline gap-1.5 text-xs">
                  <span className="text-ink">{row.label}</span>
                  <span className="flex-1" />
                  {row.percent >= DANGER ? (
                    <span className={`text-[10.5px] ${tone(row.percent).text}`}>Near limit</span>
                  ) : null}
                  <span
                    className={`min-w-[30px] text-right font-mono text-[11px] ${tone(row.percent).text}`}
                  >
                    {row.percent}%
                  </span>
                </div>
                <span className="block h-1 overflow-hidden rounded-sm bg-edge">
                  <span
                    className={`block h-full rounded-sm ${tone(row.percent).bar}`}
                    style={{ width: `${row.percent}%` }}
                  />
                </span>
                {row.sub ? (
                  <span className="font-mono text-[10.5px] text-faint">{row.sub}</span>
                ) : null}
              </div>
            ))}
          </div>
          {contextRow && contextRow.percent >= 70 ? (
            <div className="flex items-center gap-2 border-t border-edge px-2.5 py-2 text-[11px] text-dim">
              <span className="flex-1">Context is filling up</span>
              <button
                type="button"
                className="inline-flex h-5 items-center rounded-[5px] border border-edge-strong px-[7px] font-mono text-[10.5px] text-ink hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() => {
                  setOpen(false)
                  onCompact()
                }}
              >
                /compact
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </span>
  )
}
