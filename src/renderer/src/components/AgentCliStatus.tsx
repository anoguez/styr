import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentCliReport } from '@core/types.js'
import { Button, Hint } from './ui.js'

/** How long typing in the command or shell field waits before checking again. */
const SETTLE_MS = 600

const PLATFORM_NAMES: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux'
}

/** "Git Bash on Windows", "zsh on macOS": the shell and OS the check ran in. */
function where(report: AgentCliReport): string {
  const file = report.shell.replace(/\\/g, '/').split('/').pop() ?? report.shell
  const shell =
    report.platform === 'win32' && /^bash(\.exe)?$/i.test(file)
      ? 'Git Bash'
      : file.replace(/\.exe$/i, '')
  return `${shell} on ${PLATFORM_NAMES[report.platform] ?? report.platform}`
}

/**
 * Whether the provider's CLI starts from the terminal's shell, checked against the command and
 * shell as typed (not yet saved). The same check refuses a launch, so green here means ▶ Agent works.
 */
export function AgentCliStatus({
  provider,
  command,
  shell
}: {
  provider: AgentCliReport['provider']
  command: string
  shell: string
}): ReactNode {
  const [report, setReport] = useState<AgentCliReport | null>(null)
  const [checking, setChecking] = useState(true)
  const [copied, setCopied] = useState(false)
  // Answers can arrive out of order while typing; only the latest request may set the state.
  const latest = useRef(0)

  const check = useCallback(() => {
    const request = ++latest.current
    setChecking(true)
    void window.api.settings
      .agentCliStatus(provider, command.trim(), shell.trim())
      .then((next) => {
        if (request === latest.current) setReport(next)
      })
      .finally(() => {
        if (request === latest.current) setChecking(false)
      })
  }, [provider, command, shell])

  useEffect(() => {
    const timer = setTimeout(check, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [check])

  const ready = report?.status.state === 'ready'
  const title = !report
    ? 'Checking…'
    : report.status.state === 'ready'
      ? `${report.status.version} · found by ${where(report)}`
      : report.status.state === 'unsupported_shell'
        ? `Needs Git Bash on ${PLATFORM_NAMES[report.platform] ?? report.platform}`
        : report.status.state === 'missing'
          ? `Not found by ${where(report)}`
          : `Not working in ${where(report)}`

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={`size-2 shrink-0 rounded-full ${
            !report || checking ? 'bg-faint' : ready ? 'bg-col-done' : 'bg-col-review'
          }`}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink" title={title}>
          {checking && report ? 'Checking…' : title}
        </span>
        <Button className="h-6 shrink-0 px-2 text-[11.5px]" disabled={checking} onClick={check}>
          Check again
        </Button>
      </div>
      {report && !ready ? <Hint>{report.problem}</Hint> : null}
      {report?.installCommand ? (
        <div className="flex min-w-0 items-center gap-1.5 rounded-[7px] border border-edge bg-surface py-1 pl-2.5 pr-1">
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim">
            {report.installCommand}
          </code>
          <Button
            className="h-6 shrink-0 px-2 text-[11.5px]"
            onClick={() => {
              void navigator.clipboard.writeText(report.installCommand!).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1600)
              })
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
