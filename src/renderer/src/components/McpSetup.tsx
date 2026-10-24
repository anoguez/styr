import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AGENT_PROVIDER_LABELS } from '@core/types.js'
import type { McpSetupReport } from '@core/types.js'
import { Button, Chip, Hint } from './ui.js'

type Provider = McpSetupReport['provider']

/** The badge's words for a state; "Couldn't check" never claims the server is missing. */
export function mcpBadge(report: McpSetupReport): { label: string; tone: 'ok' | 'warn' | 'idle' } {
  switch (report.state) {
    case 'registered':
      return { label: 'Registered', tone: 'ok' }
    case 'stale':
      return {
        label: `Out of date — points at ${report.registeredEntry ?? 'another path'}`,
        tone: 'warn'
      }
    case 'missing':
      return { label: 'Not set up', tone: 'warn' }
    case 'unknown':
      return { label: 'Couldn’t check', tone: 'idle' }
  }
}

/** The warning shown before a launch, or null when the run can use the Styr tools or we can't tell. */
export function mcpLaunchWarning(report: McpSetupReport | null): string | null {
  if (!report || (report.state !== 'missing' && report.state !== 'stale')) return null
  const label = AGENT_PROVIDER_LABELS[report.provider]
  return `Styr tools ${report.state === 'stale' ? 'are out of date' : 'aren’t set up'} for ${label} — the run will only be able to edit files.`
}

/** The MCP setup of one provider, asked once per provider/enabled change and never blocking. */
export function useMcpSetup(provider: Provider, enabled = true): McpSetupReport | null {
  const [answer, setAnswer] = useState<McpSetupReport | null>(null)
  useEffect(() => {
    if (!enabled) return
    let current = true
    void window.api.settings
      .mcpSetupStatus(provider)
      .then((report) => current && setAnswer(report))
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [provider, enabled])
  return enabled && answer?.provider === provider ? answer : null
}

/** An inline, non-blocking warning for a dialog that launches an agent; renders nothing otherwise. */
export function McpSetupNotice({
  report,
  onOpenSettings
}: {
  report: McpSetupReport | null
  onOpenSettings: () => void
}): ReactNode {
  const warning = mcpLaunchWarning(report)
  if (!warning) return null
  return (
    <p role="status" className="px-1 text-[11.5px] text-col-review-text">
      {warning}{' '}
      <button type="button" className="underline" onClick={onOpenSettings}>
        Settings → Agents
      </button>
    </p>
  )
}

/** Settings → Agents: the badge, the re-check button and what to run, for one provider. */
export function McpSetupView({
  report,
  checking,
  onRecheck
}: {
  report: McpSetupReport | null
  checking: boolean
  onRecheck: () => void
}): ReactNode {
  const badge = report ? mcpBadge(report) : null
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate">
          <Chip
            tone={badge?.tone === 'ok' ? 'done' : badge?.tone === 'warn' ? 'warn' : 'neutral'}
            title={report?.problem || undefined}
          >
            {badge?.label ?? 'Checking…'}
          </Chip>
        </span>
        <Button className="h-6 shrink-0 px-2 text-[11.5px]" disabled={checking} onClick={onRecheck}>
          Re-check
        </Button>
      </div>
      {report?.state === 'stale' && report.removeCommand ? (
        <Hint>
          It already has a Styr server, so remove it first:{' '}
          <code className="font-mono">{report.removeCommand}</code>, then run the command below.
        </Hint>
      ) : null}
    </div>
  )
}

/** Checks `provider` on mount and on Re-check; Re-check bypasses the host's remembered answer. */
export function McpSetupStatus({ provider }: { provider: Provider }): ReactNode {
  const [report, setReport] = useState<McpSetupReport | null>(null)
  const [checking, setChecking] = useState(true)
  const latest = useRef(0)

  const check = useCallback(
    (fresh: boolean) => {
      const request = ++latest.current
      setChecking(true)
      void window.api.settings
        .mcpSetupStatus(provider, fresh)
        .then((next) => request === latest.current && setReport(next))
        .catch(() => undefined)
        .finally(() => request === latest.current && setChecking(false))
    },
    [provider]
  )

  useEffect(() => check(false), [check])

  return <McpSetupView report={report} checking={checking} onRecheck={() => check(true)} />
}
