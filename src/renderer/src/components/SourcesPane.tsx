import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { CliStatus, SourceConfig, SourceSyncState, SourceTarget } from '@core/types.js'
import { Button, Card, CardRow, Chip, Hint, Segmented, Select, Switch, inputBase } from './ui.js'
import { PLATFORM } from '../lib/platform.js'

const PROVIDER = 'github'

/** What the status card says for each state of the provider's command-line tool. */
function cliCopy(status: CliStatus | null): {
  tone: 'ok' | 'warn' | 'idle'
  title: string
  detail: string
  command?: string
} {
  if (!status) return { tone: 'idle', title: 'Checking the GitHub CLI…', detail: '' }
  switch (status.state) {
    case 'missing':
      return {
        tone: 'warn',
        title: 'GitHub CLI not found',
        detail:
          'Styr talks to GitHub through the gh command, so it keeps no token of its own. Install it, then check again.',
        command: PLATFORM === 'win32' ? 'winget install --id GitHub.cli' : 'brew install gh'
      }
    case 'outdated':
      return {
        tone: 'warn',
        title: `gh ${status.version} is too old`,
        detail: `Version ${status.minimum} or newer is needed.`,
        command: PLATFORM === 'win32' ? 'winget upgrade --id GitHub.cli' : 'brew upgrade gh'
      }
    case 'unauthenticated':
      return {
        tone: 'warn',
        title: 'gh is not logged in',
        detail: 'Run this in a terminal, then check again.',
        command: 'gh auth login'
      }
    case 'ready':
      return {
        tone: 'ok',
        title: status.account ? `Signed in as ${status.account}` : 'GitHub CLI is ready',
        detail: `gh ${status.version}`
      }
  }
}

const DEFAULT_SOURCE: SourceConfig = {
  id: PROVIDER,
  provider: PROVIDER,
  access: 'read',
  enabled: false,
  pollMinutes: 5,
  labels: [],
  includeClosed: false,
  mirrorStatus: false,
  commentOnReview: false
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] items-start gap-2.5">
      <span className="pt-[5px] text-[12px] text-dim">{label}</span>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  )
}

/**
 * The GitHub pane of Settings. One switch turns the integration on and one control sets whether
 * Styr may write back; the repositories are not entered here but found from the tasks' own
 * checkouts. The gh status card comes first, because nothing below it works without the CLI.
 */
export function SourcesPane({
  sources,
  saved,
  canAct,
  onChange
}: {
  sources: SourceConfig[]
  saved: SourceConfig[]
  /** Syncing reads the saved settings of the active workspace, so only that one can act. */
  canAct: boolean
  onChange: (sources: SourceConfig[]) => void
}): ReactNode {
  const [status, setStatus] = useState<CliStatus | null>(null)
  const [state, setState] = useState<SourceSyncState | undefined>()
  const [targets, setTargets] = useState<SourceTarget[]>([])
  const [copied, setCopied] = useState(false)

  const recheck = useCallback(() => {
    setStatus(null)
    window.api.sources.ghStatus().then(setStatus, () => setStatus({ state: 'missing' }))
  }, [])

  useEffect(() => {
    recheck()
    void window.api.sources.state().then((all) => setState(all[PROVIDER]))
    return window.api.sources.onState((all) => setState(all[PROVIDER]))
  }, [recheck])

  const source = sources.find((item) => item.provider === PROVIDER) ?? DEFAULT_SOURCE
  const savedSource = saved.find((item) => item.provider === PROVIDER)
  const dirty = JSON.stringify(savedSource ?? DEFAULT_SOURCE) !== JSON.stringify(source)
  const savedOn = savedSource?.enabled === true

  useEffect(() => {
    if (!canAct || !savedOn) return setTargets([])
    window.api.sources.targets(PROVIDER).then(setTargets, () => setTargets([]))
  }, [canAct, savedOn, state?.lastAt])

  const copy = cliCopy(status)
  const ready = status?.state === 'ready'
  const writable = source.access === 'read_write'

  function change(changes: Partial<SourceConfig>): void {
    const next = { ...source, ...changes }
    onChange(
      sources.some((item) => item.provider === PROVIDER)
        ? sources.map((item) => (item.provider === PROVIDER ? next : item))
        : [...sources, next]
    )
  }

  function setAccess(access: SourceConfig['access']): void {
    if (access === 'read_write') {
      const ok = window.confirm(
        'Let Styr change GitHub?\n\nWith read & write, Styr can close and reopen issues and post comments in the repositories of your tasks. Read-only never changes anything.'
      )
      if (!ok) return
      change({ access })
    } else {
      // a read-only integration can never mirror or comment, so the options go off with it
      change({ access, mirrorStatus: false, commentOnReview: false })
    }
  }

  return (
    <>
      <Card>
        <div className="flex items-center gap-3 px-3.5 py-3">
          <span
            aria-hidden
            className={`size-2 shrink-0 rounded-full ${
              copy.tone === 'ok'
                ? 'bg-col-done'
                : copy.tone === 'warn'
                  ? 'bg-col-review'
                  : 'bg-faint'
            }`}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-semibold text-ink">{copy.title}</span>
            {copy.detail ? <span className="text-[11.5px] text-faint">{copy.detail}</span> : null}
          </span>
          <Button variant="subtle" onClick={recheck}>
            Check again
          </Button>
        </div>
        {copy.command ? (
          <div className="flex items-center gap-2 border-t border-edge px-3.5 py-2.5">
            <code className="min-w-0 flex-1 rounded-md bg-panel px-2.5 py-1.5 font-mono text-[11.5px] text-ink">
              {copy.command}
            </code>
            <Button
              variant="subtle"
              onClick={() => {
                void navigator.clipboard.writeText(copy.command!)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button
              variant="subtle"
              onClick={() => void window.api.terminal.openLink('https://cli.github.com')}
            >
              cli.github.com
            </Button>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardRow className="flex items-center gap-3 px-3.5 py-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              GitHub issues
              {source.enabled ? (
                <Chip tone={writable ? 'warn' : 'neutral'}>
                  {writable ? 'Read & write' : 'Read-only'}
                </Chip>
              ) : null}
            </span>
            <span className="text-[11.5px] text-faint">
              {source.enabled
                ? 'Issues of the repositories your tasks live in are imported and linked.'
                : 'Off. Nothing is read from or written to GitHub.'}
            </span>
          </span>
          <Switch
            label="Enable GitHub issues"
            checked={source.enabled}
            disabled={!ready && !source.enabled}
            title={ready || source.enabled ? undefined : 'Install and sign in to gh first'}
            onChange={(enabled) => change({ enabled })}
          />
        </CardRow>

        {source.enabled ? (
          <>
            <CardRow className="flex flex-col gap-3 px-3.5 py-3">
              <Row label="Access">
                <Segmented
                  label="Access to GitHub"
                  value={source.access}
                  onChange={setAccess}
                  options={[
                    { value: 'read', label: 'Read-only' },
                    { value: 'read_write', label: 'Read & write' }
                  ]}
                />
                <Hint>
                  {writable
                    ? 'Styr may close, reopen and comment on issues, only as set below.'
                    : 'Styr only reads. It never changes, comments on or closes anything on GitHub.'}
                </Hint>
              </Row>
              <Row label="Mirror status">
                <Switch
                  label="Close the issue when the task is Done"
                  checked={source.mirrorStatus}
                  disabled={!writable}
                  title={writable ? undefined : 'Needs read & write access'}
                  onChange={(mirrorStatus) => change({ mirrorStatus })}
                />
                <Hint>Done closes the issue; moving the task out of Done reopens it.</Hint>
              </Row>
              <Row label="Comment on review">
                <Switch
                  label="Comment the pull request when a task enters In Review"
                  checked={source.commentOnReview}
                  disabled={!writable}
                  title={writable ? undefined : 'Needs read & write access'}
                  onChange={(commentOnReview) => change({ commentOnReview })}
                />
              </Row>
            </CardRow>

            <CardRow className="flex flex-col gap-3 px-3.5 py-3">
              <Row label="Labels">
                <input
                  aria-label="Labels"
                  placeholder="All issues, or comma-separated labels"
                  className={`${inputBase} h-7 w-full max-w-[320px] px-2.5 text-[12px]`}
                  value={source.labels.join(', ')}
                  onChange={(event) =>
                    change({
                      labels: event.target.value
                        .split(',')
                        .map((label) => label.trim())
                        .filter(Boolean)
                    })
                  }
                />
                <Hint>Only issues carrying every label are imported.</Hint>
              </Row>
              <Row label="Closed issues">
                <Switch
                  label="Import closed issues"
                  checked={source.includeClosed}
                  onChange={(includeClosed) => change({ includeClosed })}
                />
              </Row>
              <Row label="Check every">
                <Select
                  aria-label="Poll interval"
                  compact
                  value={String(source.pollMinutes)}
                  onChange={(event) => change({ pollMinutes: Number(event.target.value) })}
                >
                  <option value="0">Manual only</option>
                  <option value="1">1 minute</option>
                  <option value="5">5 minutes</option>
                  <option value="15">15 minutes</option>
                  <option value="60">1 hour</option>
                </Select>
              </Row>
            </CardRow>

            <CardRow className="flex flex-col gap-2 px-3.5 py-3">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium text-dim">Repositories</span>
                <span className="flex-1" />
                <Button
                  variant="subtle"
                  disabled={!ready || !canAct || dirty || state?.syncing}
                  title={dirty ? 'Save first, then sync' : undefined}
                  onClick={() => void window.api.sources.sync(PROVIDER)}
                >
                  {state?.syncing ? 'Syncing…' : 'Sync now'}
                </Button>
              </div>
              {dirty ? (
                <Hint>Save to find the repositories and sync.</Hint>
              ) : targets.length > 0 ? (
                targets.map((item) => (
                  <div key={item.target} className="flex items-baseline gap-2 text-[12px]">
                    <span className="font-mono text-ink">{item.target}</span>
                    <span className="min-w-0 truncate text-faint" title={item.repoPath}>
                      {item.repoPath}
                    </span>
                  </div>
                ))
              ) : (
                <Hint>
                  None found yet. Styr reads them from the git remote of each task&apos;s repo path
                  and the default repo path in General.
                </Hint>
              )}
              <Hint>
                {state?.error
                  ? state.error
                  : state?.lastAt
                    ? `Last synced ${new Date(state.lastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: ${state.created} new, ${state.updated} updated.`
                    : 'Not synced yet.'}
              </Hint>
            </CardRow>
          </>
        ) : null}
      </Card>
      <Hint>
        Issues are imported as Backlog tasks that need a spec, with the repo path set, and stay
        linked. Read-only never writes to GitHub.
      </Hint>
    </>
  )
}
