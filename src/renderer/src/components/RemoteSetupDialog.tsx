import { useEffect, useState, type ReactNode } from 'react'
import { isValidRemoteHost } from '@core/remote.js'
import type {
  RemoteSetupProgress,
  RemoteSetupResult,
  RemoteSetupStep,
  WorkspaceOverview
} from '@core/types.js'
import { ipcMessage } from '../lib/ipcMessage.js'
import { transferLabel } from '../lib/remoteStatus.js'
import { Button, Card, CardRow, Field, Hint, Modal, Segmented, inputClass } from './ui.js'

const STEPS: { id: RemoteSetupStep; label: string }[] = [
  { id: 'check', label: 'Reach the host over ssh' },
  { id: 'probe', label: 'Check the system, git and the agent CLI' },
  { id: 'install', label: 'Install or reuse the Styr server' },
  { id: 'create', label: 'Create the workspace' }
]

/**
 * New workspace → Remote (`docs/architecture/remote.md`, Host setup): a host and a name, then the
 * steps as they run on the host, ssh's own error when one fails, and what setup found (how the
 * server got there, warnings, the linger command to copy). Styr never asks for a password.
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
  const [provider, setProvider] = useState<'claude' | 'codex'>('claude')
  const [progress, setProgress] = useState<Partial<Record<RemoteSetupStep, RemoteSetupProgress>>>(
    {}
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<RemoteSetupResult>()
  const hostOk = isValidRemoteHost(host.trim())

  useEffect(
    () =>
      window.api.remote.onSetupProgress((update) => {
        if (update.host !== host.trim()) return
        setProgress((current) => ({ ...current, [update.step]: update }))
      }),
    [host]
  )

  async function submit(): Promise<void> {
    if (busy || result || !name.trim() || !hostOk) return
    setBusy(true)
    setError('')
    setProgress({})
    try {
      const done = await window.api.remote.setup({ name, host: host.trim(), provider })
      onApply(await window.api.workspaces.list())
      setResult(done)
    } catch (failure) {
      setError(ipcMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const started = busy || error || result
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
            <Button
              variant="primary"
              disabled={busy || !name.trim() || !hostOk}
              onClick={() => void submit()}
            >
              {busy ? 'Setting up…' : error ? 'Retry' : 'Set up and open'}
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
        <Field label="Name" hint="How it reads in the workspace switcher.">
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
        <Field
          label="Host"
          hint="Whatever ssh accepts: an alias from ~/.ssh/config, or user@address. Styr runs ssh in batch mode and never asks for a password: set up a key or Tailscale SSH first."
        >
          <input
            className={inputClass}
            value={host}
            spellCheck={false}
            placeholder="me@100.64.0.2"
            disabled={busy || Boolean(result)}
            onChange={(event) => setHost(event.target.value)}
          />
        </Field>
        {host.trim() && !hostOk ? (
          <p className="text-[12px] text-danger">That is not a host ssh can reach.</p>
        ) : null}
        <Field label="Agent CLI" hint="Looked for on the host; setup warns when it is missing.">
          <Segmented
            label="Agent CLI"
            value={provider}
            options={[
              { value: 'claude', label: 'Claude Code' },
              { value: 'codex', label: 'Codex' }
            ]}
            onChange={setProvider}
          />
        </Field>

        {started ? (
          <Card>
            {STEPS.map((step) => {
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
            The host needs Linux, ssh, git and the agent CLI, logged in. The host downloads the Styr
            server from the release and checks it against the hash built into this app; when it
            cannot reach GitHub, this computer uploads it. Only a link is kept here.
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
