import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { CliStatus, SourceCheck, SourceConfig, SourceSyncState } from '@core/types.js'
import { Button, Card, CardRow, Chip, Hint, Segmented, Select, Switch, inputBase } from './ui.js'

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
        command: 'brew install gh'
      }
    case 'outdated':
      return {
        tone: 'warn',
        title: `gh ${status.version} is too old`,
        detail: `Version ${status.minimum} or newer is needed.`,
        command: 'brew upgrade gh'
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

function sameSource(a: SourceConfig | undefined, b: SourceConfig): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b)
}

function newSource(): SourceConfig {
  return {
    id: `github-${Math.random().toString(36).slice(2, 8)}`,
    provider: 'github',
    name: '',
    access: 'read',
    enabled: true,
    pollMinutes: 5,
    repo: '',
    labels: [],
    includeClosed: false,
    mirrorStatus: false,
    commentOnReview: false
  }
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] items-start gap-2.5">
      <span className="pt-[5px] text-[12px] text-dim">{label}</span>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  )
}

function SourceCard({
  source,
  saved,
  canAct,
  state,
  ready,
  onChange,
  onRemove
}: {
  source: SourceConfig
  saved: SourceConfig | undefined
  canAct: boolean
  state: SourceSyncState | undefined
  ready: boolean
  onChange: (changes: Partial<SourceConfig>) => void
  onRemove: () => void
}): ReactNode {
  const [check, setCheck] = useState<SourceCheck | 'testing' | null>(null)
  const writable = source.access === 'read_write'
  const dirty = !sameSource(saved, source)

  function setAccess(access: SourceConfig['access']): void {
    if (access === 'read_write') {
      const ok = window.confirm(
        `Let Styr change ${source.repo || 'this source'}?\n\nWith read & write, Styr can close and reopen issues and post comments there. Read-only never changes anything.`
      )
      if (!ok) return
      onChange({ access })
    } else {
      // a read-only source can never mirror or comment, so the options go off with it
      onChange({ access, mirrorStatus: false, commentOnReview: false })
    }
  }

  function test(): void {
    setCheck('testing')
    window.api.sources
      .test(source)
      .then(setCheck, (error: unknown) =>
        setCheck({ ok: false, reason: error instanceof Error ? error.message : String(error) })
      )
  }

  return (
    <Card>
      <CardRow className="flex items-center gap-3 px-3.5 py-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            {source.repo || 'New GitHub source'}
            <Chip tone={writable ? 'warn' : 'neutral'}>
              {writable ? 'Read & write' : 'Read-only'}
            </Chip>
          </span>
          <span className="text-[11.5px] text-faint">
            {state?.syncing
              ? 'Syncing…'
              : state?.error
                ? state.error
                : state?.lastAt
                  ? `Last synced ${new Date(state.lastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: ${state.created} new, ${state.updated} updated.`
                  : 'Not synced yet.'}
          </span>
        </span>
        <Switch
          label={`Enable ${source.repo || 'source'}`}
          checked={source.enabled}
          onChange={(enabled) => onChange({ enabled })}
        />
      </CardRow>

      <CardRow className="flex flex-col gap-3 px-3.5 py-3">
        <Row label="Repository">
          <input
            aria-label="Repository"
            placeholder="owner/name"
            className={`${inputBase} h-7 w-full max-w-[260px] px-2.5 font-mono text-[11.5px]`}
            value={source.repo}
            onChange={(event) => onChange({ repo: event.target.value.trim() })}
          />
        </Row>
        <Row label="Name">
          <input
            aria-label="Source name"
            placeholder={source.repo || 'Shown in notes'}
            className={`${inputBase} h-7 w-full max-w-[260px] px-2.5 text-[12px]`}
            value={source.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </Row>
        <Row label="Labels">
          <input
            aria-label="Labels"
            placeholder="All issues, or comma-separated labels"
            className={`${inputBase} h-7 w-full max-w-[320px] px-2.5 text-[12px]`}
            value={source.labels.join(', ')}
            onChange={(event) =>
              onChange({
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
            onChange={(includeClosed) => onChange({ includeClosed })}
          />
        </Row>
        <Row label="Check every">
          <Select
            aria-label="Poll interval"
            compact
            value={String(source.pollMinutes)}
            onChange={(event) => onChange({ pollMinutes: Number(event.target.value) })}
          >
            <option value="0">Manual only</option>
            <option value="1">1 minute</option>
            <option value="5">5 minutes</option>
            <option value="15">15 minutes</option>
            <option value="60">1 hour</option>
          </Select>
        </Row>
      </CardRow>

      <CardRow className="flex flex-col gap-3 px-3.5 py-3">
        <Row label="Access">
          <Segmented
            label="Access to the source"
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
              : 'Styr only reads. It never changes, comments on or closes anything there.'}
          </Hint>
        </Row>
        <Row label="Mirror status">
          <Switch
            label="Close the issue when the task is Done"
            checked={source.mirrorStatus}
            disabled={!writable}
            title={writable ? undefined : 'Needs read & write access'}
            onChange={(mirrorStatus) => onChange({ mirrorStatus })}
          />
          <Hint>Done closes the issue; moving the task out of Done reopens it.</Hint>
        </Row>
        <Row label="Comment on review">
          <Switch
            label="Comment the pull request when a task enters In Review"
            checked={source.commentOnReview}
            disabled={!writable}
            title={writable ? undefined : 'Needs read & write access'}
            onChange={(commentOnReview) => onChange({ commentOnReview })}
          />
        </Row>
      </CardRow>

      <CardRow className="flex flex-wrap items-center gap-2 px-3.5 py-3">
        <Button
          variant="subtle"
          disabled={!ready || !source.repo || check === 'testing'}
          onClick={test}
        >
          Test connection
        </Button>
        <Button
          variant="subtle"
          disabled={!ready || !canAct || dirty || state?.syncing}
          title={dirty ? 'Save first, then sync' : undefined}
          onClick={() => void window.api.sources.sync(source.id)}
        >
          Sync now
        </Button>
        <span className="min-w-0 flex-1 text-[11.5px] text-faint">
          {check === 'testing'
            ? 'Testing…'
            : check
              ? check.ok
                ? 'Connected.'
                : check.reason
              : dirty
                ? 'Unsaved changes.'
                : ''}
        </span>
        <Button variant="subtle" onClick={onRemove}>
          Remove
        </Button>
      </CardRow>
    </Card>
  )
}

/**
 * The GitHub pane of Settings. The gh status card comes first, because nothing below it can work
 * without the CLI; until it is ready the source controls that talk to GitHub stay off.
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
  const [states, setStates] = useState<Record<string, SourceSyncState>>({})
  const [copied, setCopied] = useState(false)

  const recheck = useCallback(() => {
    setStatus(null)
    window.api.sources.ghStatus().then(setStatus, () => setStatus({ state: 'missing' }))
  }, [])

  useEffect(() => {
    recheck()
    void window.api.sources.state().then(setStates)
    return window.api.sources.onState(setStates)
  }, [recheck])

  const copy = cliCopy(status)
  const ready = status?.state === 'ready'
  const github = sources.filter((source) => source.provider === 'github')

  function change(id: string, changes: Partial<SourceConfig>): void {
    onChange(sources.map((source) => (source.id === id ? { ...source, ...changes } : source)))
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

      {github.map((source) => (
        <SourceCard
          key={source.id}
          source={source}
          saved={saved.find((item) => item.id === source.id)}
          canAct={canAct}
          state={states[source.id]}
          ready={ready}
          onChange={(changes) => change(source.id, changes)}
          onRemove={() => onChange(sources.filter((item) => item.id !== source.id))}
        />
      ))}

      <div>
        <Button
          variant="subtle"
          disabled={!ready}
          title={ready ? undefined : 'Install and sign in to gh first'}
          onClick={() => onChange([...sources, newSource()])}
        >
          Add a GitHub repository
        </Button>
      </div>
      <Hint>
        Issues are imported as Backlog tasks that need a spec, and stay linked. Read-only sources
        are never written to.
      </Hint>
    </>
  )
}
