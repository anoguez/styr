import { useEffect, useState, type ReactNode } from 'react'
import { isValidRemoteHost } from '@core/remote.js'
import type {
  RemoteHostInspection,
  RemoteSetupProgress,
  RemoteSetupResult,
  RemoteSetupStep,
  WorkspaceOverview
} from '@core/types.js'
import { ipcMessage } from '../lib/ipcMessage.js'
import { transferLabel, useRemoteState } from '../lib/remoteStatus.js'
import { Button, Card, CardRow, Chip, Field, Hint, Modal, Segmented, inputClass } from './ui.js'

export type WorkspacePlaceValue = 'local' | 'remote'

/**
 * New workspace's "Where the workspace lives" toggle, in the switcher's dialog and in Settings →
 * Workspaces. Nothing at all with remote workspaces off (Experimental).
 */
export function WorkspacePlace({
  value,
  onChange
}: {
  value: WorkspacePlaceValue
  onChange: (value: WorkspacePlaceValue) => void
}): ReactNode {
  const remote = useRemoteState()
  if (!remote.enabled) return null
  return (
    <Segmented
      label="Where the workspace lives"
      value={value}
      options={[
        { value: 'local', label: 'This computer' },
        { value: 'remote', label: 'Remote host' }
      ]}
      onChange={onChange}
    />
  )
}

const STEPS: { id: RemoteSetupStep; label: string; creates?: boolean }[] = [
  { id: 'check', label: 'Reach the host over ssh' },
  { id: 'probe', label: 'Check the system: Linux, architecture, glibc, systemd' },
  { id: 'install', label: 'Install or reuse the Styr server', creates: true },
  { id: 'create', label: 'Create the workspace', creates: true }
]

/** What the dialog does once the host is inspected: set up a new board, or open one it has. */
type Choice = 'new' | 'existing'

/**
 * New workspace → Remote host (`docs/architecture/remote.md`, Host setup), from every entry: the
 * switcher, Settings → Workspaces, Settings → Remote hosts and the palette. A host first: ssh and
 * the system are checked (`remote:inspect`). When a server already runs there with boards, it
 * offers to open one by name (only a local link is written) or to create a new one; otherwise it
 * asks for a name and sets the host up. Nothing about agents is checked: like a local workspace,
 * a remote one checks its agent CLI in Settings → Agents and before a launch. Styr never asks for
 * a password.
 */
export function RemoteSetupDialog({
  switcher,
  onApply,
  onClose
}: {
  /** The Local / Remote toggle, owned by the New workspace dialog. */
  switcher: ReactNode
  onApply: (overview: WorkspaceOverview) => void
  onClose: () => void
}): ReactNode {
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [progress, setProgress] = useState<Partial<Record<RemoteSetupStep, RemoteSetupProgress>>>(
    {}
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [inspection, setInspection] = useState<RemoteHostInspection>()
  const [choice, setChoice] = useState<Choice>('new')
  const [boardId, setBoardId] = useState<string>()
  const [result, setResult] = useState<RemoteSetupResult>()
  const hostOk = isValidRemoteHost(host.trim())
  const boards = inspection?.boards ?? []
  const opening = choice === 'existing' && boards.length > 0

  useEffect(
    () =>
      window.api.remote.onSetupProgress((update) => {
        if (update.host !== host.trim()) return
        setProgress((current) => ({ ...current, [update.step]: update }))
      }),
    [host]
  )

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (failure) {
      setError(ipcMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  /** ssh and the system, and what a running server already has. */
  async function inspect(): Promise<void> {
    setProgress({})
    await run(async () => {
      const found = await window.api.remote.inspect(host.trim())
      const open = found.boards.find((board) => !board.linked)
      setInspection(found)
      setChoice(open ? 'existing' : 'new')
      setBoardId(open?.id)
      if (open) setName(open.name)
    })
  }

  async function submit(): Promise<void> {
    if (busy || result || !hostOk) return
    if (!inspection) return inspect()
    if (!name.trim()) return
    if (opening) {
      if (!boardId) return
      // Only the local stub: nothing is installed or written on the host.
      return run(async () => {
        onApply(
          await window.api.remote.addWorkspace({ name, host: host.trim(), workspaceId: boardId })
        )
        onClose()
      })
    }
    return run(async () => {
      const done = await window.api.remote.setup({ name, host: host.trim() })
      onApply(await window.api.workspaces.list())
      setResult(done)
    })
  }

  const started = Object.keys(progress).length > 0 || busy || error
  const ready = hostOk && (!inspection || (name.trim() !== '' && (!opening || Boolean(boardId))))
  const action = !inspection
    ? busy
      ? 'Checking…'
      : error
        ? 'Retry'
        : 'Continue'
    : opening
      ? busy
        ? 'Opening…'
        : 'Open'
      : busy
        ? 'Setting up…'
        : error
          ? 'Retry'
          : 'Set up and open'
  return (
    <Modal
      title="New workspace"
      subtitle="A board on another machine, reached over ssh. Its agents keep running while this computer sleeps."
      onClose={onClose}
      onSubmit={() => void submit()}
      backdropCloses={!busy}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="subtle" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || !ready} onClick={() => void submit()}>
              {action}
            </Button>
          </>
        )
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {switcher}
        <Field
          label="Host"
          hint="Whatever ssh accepts: an alias from ~/.ssh/config, or user@address. Styr runs ssh in batch mode and never asks for a password: set up a key or Tailscale SSH first."
        >
          <input
            autoFocus
            className={inputClass}
            value={host}
            spellCheck={false}
            placeholder="me@100.64.0.2"
            disabled={busy || Boolean(result)}
            onChange={(event) => {
              // Another host: what was found on the last one no longer applies.
              setHost(event.target.value)
              setInspection(undefined)
              setProgress({})
              setError('')
            }}
          />
        </Field>
        {host.trim() && !hostOk ? (
          <p className="text-[12px] text-danger">That is not a host ssh can reach.</p>
        ) : null}

        {inspection && boards.length > 0 ? (
          <div className="flex flex-col gap-2.5">
            <p className="text-[12px] text-dim">
              {host.trim()} already runs a Styr server
              {inspection.running && inspection.running !== 'unknown'
                ? ` (${inspection.running})`
                : ''}{' '}
              with {boards.length === 1 ? 'a workspace' : `${boards.length} workspaces`}.
            </p>
            <Segmented
              label="Workspace on the host"
              value={choice}
              options={[
                { value: 'existing', label: 'Open an existing workspace' },
                { value: 'new', label: 'Create a new workspace' }
              ]}
              onChange={(next) => {
                setChoice(next)
                const board = boards.find((entry) => entry.id === boardId)
                setName(next === 'existing' && board ? board.name : '')
              }}
            />
            {opening ? (
              <Card>
                {boards.map((board) => (
                  <CardRow key={board.id}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={board.id === boardId}
                      disabled={board.linked || busy}
                      className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[12.5px] ${
                        board.id === boardId ? 'bg-raised text-ink' : 'text-dim hover:text-ink'
                      } disabled:pointer-events-none disabled:opacity-60`}
                      onClick={() => {
                        setBoardId(board.id)
                        setName(board.name)
                      }}
                    >
                      <span aria-hidden className="w-3 shrink-0 text-[12px]">
                        {board.id === boardId ? '●' : '○'}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{board.name}</span>
                      {board.linked ? <Chip>Already on this computer</Chip> : null}
                    </button>
                  </CardRow>
                ))}
              </Card>
            ) : null}
          </div>
        ) : null}

        {inspection ? (
          <Field
            label="Name"
            hint={
              opening
                ? 'How it reads in the workspace switcher, on this computer only.'
                : 'How it reads in the workspace switcher.'
            }
          >
            <input
              autoFocus
              className={inputClass}
              value={name}
              maxLength={40}
              placeholder="Devbox"
              disabled={busy || Boolean(result)}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        ) : null}

        {started ? (
          <Card>
            {STEPS.filter((step) => !step.creates || (inspection && !opening)).map((step) => {
              const update = progress[step.id]
              return (
                <CardRow key={step.id} className="flex gap-2.5 px-3.5 py-2">
                  <span aria-hidden className={`w-3 shrink-0 text-[12px] ${stepTone(update)}`}>
                    {update?.state === 'done' ? '✓' : update?.state === 'failed' ? '✕' : '•'}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span
                      className={`text-[12.5px] ${update ? 'text-ink' : 'text-faint'} ${update?.state === 'running' ? 'font-medium' : ''}`}
                    >
                      {step.label}
                      {update?.state === 'running' ? '…' : ''}
                    </span>
                    {update?.detail && update.state === 'done' ? (
                      <span className="text-[11px] text-dim">{update.detail}</span>
                    ) : null}
                  </span>
                </CardRow>
              )
            })}
          </Card>
        ) : null}

        {error ? (
          <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg border border-edge bg-chrome/40 px-3 py-2.5 font-mono text-[11.5px] text-danger">
            {error}
          </pre>
        ) : null}

        {result ? <SetupSummary result={result} /> : null}

        {!started ? (
          <Hint>
            The host needs Linux and ssh. Styr checks it first; when a Styr server already runs
            there, you can open one of its workspaces. Otherwise the host downloads the Styr server
            from the release and checks it against the hash built into this app; when it cannot
            reach GitHub, this computer uploads it. Only a link is kept here.
          </Hint>
        ) : null}
      </form>
    </Modal>
  )
}

function stepTone(update?: RemoteSetupProgress): string {
  if (update?.state === 'done') return 'text-[var(--color-col-done)]'
  if (update?.state === 'failed') return 'text-danger'
  return 'text-faint'
}

function SetupSummary({ result }: { result: RemoteSetupResult }): ReactNode {
  const [copied, setCopied] = useState(false)
  const linger = result.lingerCommand
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[12.5px] text-ink">The board is open and connected.</p>
      <p className="text-[12px] text-dim">{transferLabel(result.transfer)}</p>
      {result.warnings.map((warning) => (
        <p key={warning} className="text-[12px] text-[var(--color-col-review)]">
          {warning}
        </p>
      ))}
      {linger ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[12px] text-dim">
            Lingering is off on the host, so the server stops when your last session there ends. To
            keep it running while you are logged out, run this once on the host. Styr does not run
            it, because it needs sudo.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md border border-edge bg-chrome/40 px-2.5 py-1.5 font-mono text-[11.5px] text-ink">
              {linger}
            </code>
            <Button
              className="h-[28px] px-2.5"
              onClick={() => void navigator.clipboard.writeText(linger).then(() => setCopied(true))}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
