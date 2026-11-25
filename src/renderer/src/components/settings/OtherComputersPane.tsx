import { useEffect, useState, type ReactNode } from 'react'
import type { LanBoard, LanHostInfo, RemoteState, WorkspaceOverview } from '@core/types.js'
import { groupedCode, lanHostStatus } from '../../lib/accessView.js'
import { ipcMessage } from '../../lib/ipcMessage.js'
import { useRemoteState } from '../../lib/remoteStatus.js'
import { PlusIcon } from '../icons.js'
import { Button, Card, CardRow, Eyebrow, Hint, Modal, inputClass } from '../ui.js'
import { DevicesGlyph } from './ConnectDialogs.js'

/**
 * Settings → Connections → Other computers: open the workspaces another Styr on the same network
 * shares with this one. This desktop pairs with it as a device would, by approval: the person
 * there allows it after comparing a code. Its workspaces then open like any remote workspace
 * (`docs/architecture/remote.md`), behind the same Experimental switch.
 */
export function OtherComputersPane({
  remoteEnabled,
  overview,
  onOpenExperimental
}: {
  /** Settings → Experimental → Remote workspaces, as saved. */
  remoteEnabled: boolean
  overview: WorkspaceOverview
  onOpenExperimental: () => void
}): ReactNode {
  const remote = useRemoteState()
  const [hosts, setHosts] = useState<LanHostInfo[]>()
  const [adding, setAdding] = useState(false)
  const [opening, setOpening] = useState<LanHostInfo>()
  const [error, setError] = useState('')

  const reload = (): void => void window.api.lan.hosts().then(setHosts, () => setHosts([]))
  useEffect(reload, [])

  if (!remoteEnabled) {
    return (
      <Card className="items-center gap-3 px-6 py-8 text-center">
        <DevicesGlyph />
        <span className="max-w-sm text-[12.5px] leading-relaxed text-dim">
          Opening another computer&apos;s workspaces uses Remote workspaces, which is still
          experimental. Switch it on first.
        </span>
        <Button onClick={onOpenExperimental}>Open Experimental</Button>
      </Card>
    )
  }
  if (!hosts) return null

  async function remove(host: LanHostInfo): Promise<void> {
    const linked = overview.workspaces.filter(
      (workspace) => workspace.remote?.lan?.fingerprint === host.fingerprint
    ).length
    const what =
      linked > 0 ? ` Its ${linked} workspace${linked === 1 ? '' : 's'} here will go offline.` : ''
    if (!window.confirm(`Forget ${host.name}? This computer's key for it is deleted.${what}`))
      return
    setError('')
    try {
      await window.api.lan.remove(host.fingerprint)
      reload()
    } catch (failure) {
      setError(ipcMessage(failure))
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {error ? (
        <span role="alert" className="text-[12px] text-danger">
          {error}
        </span>
      ) : null}
      {hosts.length === 0 ? (
        <Card className="items-center gap-3 px-6 py-8 text-center">
          <DevicesGlyph />
          <span className="max-w-sm text-[12.5px] leading-relaxed text-dim">
            Open the workspaces another computer on your network shares with you. It needs Styr with
            Connections switched on.
          </span>
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add computer
          </Button>
        </Card>
      ) : (
        <section className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <Eyebrow>Computers</Eyebrow>
            <Button className="h-[26px] px-2.5" onClick={() => setAdding(true)}>
              <PlusIcon size={12} />
              Add computer
            </Button>
          </div>
          <Card>
            {hosts.map((host) => (
              <HostRow
                key={host.fingerprint}
                host={host}
                remote={remote}
                overview={overview}
                onOpen={() => setOpening(host)}
                onRemove={() => void remove(host)}
              />
            ))}
          </Card>
          <Hint>
            You see only the workspaces each computer shares, and you can run commands in them. They
            stay on that computer: when it sleeps or leaves the network, they go offline here.
          </Hint>
        </section>
      )}

      {adding ? (
        <AddComputerDialog
          onClose={() => setAdding(false)}
          onPaired={(host) => {
            setAdding(false)
            reload()
            setOpening(host)
          }}
        />
      ) : null}
      {opening ? (
        <OpenWorkspaceDialog host={opening} onClose={() => setOpening(undefined)} />
      ) : null}
    </div>
  )
}

function HostRow({
  host,
  remote,
  overview,
  onOpen,
  onRemove
}: {
  host: LanHostInfo
  remote: RemoteState
  overview: WorkspaceOverview
  onOpen: () => void
  onRemove: () => void
}): ReactNode {
  const status = lanHostStatus(host, overview, remote)
  return (
    <CardRow className="flex items-center gap-3 px-3.5 py-2.5">
      <span
        aria-hidden
        className={`size-2 shrink-0 rounded-full ${status.connected ? 'bg-accent' : 'bg-edge-strong'}`}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[12.5px] font-medium text-ink">{host.name}</span>
        <span className="truncate font-mono text-[10.5px] text-faint">
          {host.address}:{host.port} · {status.text}
        </span>
      </span>
      <Button className="h-[26px] px-2.5" onClick={onOpen}>
        Open a workspace…
      </Button>
      <Button variant="danger" className="h-[26px] px-2.5" onClick={onRemove}>
        Forget
      </Button>
    </CardRow>
  )
}

/**
 * Pairs with another computer by approval: its address, then the code to compare while the person
 * there allows this one in its Add device window.
 */
function AddComputerDialog({
  onClose,
  onPaired
}: {
  onClose: () => void
  onPaired: (host: LanHostInfo) => void
}): ReactNode {
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState<string>()
  const [busy, setBusy] = useState(false)
  /** The other computer allowed this one; the person here has yet to say the codes matched. */
  const [allowed, setAllowed] = useState<{ code: string; name: string }>()
  const [error, setError] = useState('')

  useEffect(() => window.api.lan.onPairCode((update) => setCode(update.code)), [])
  // Closing at any point hangs up, and drops a pairing not yet confirmed here: nothing is kept.
  useEffect(() => () => void window.api.lan.cancelPair(), [])

  async function connect(): Promise<void> {
    setBusy(true)
    setError('')
    setCode(undefined)
    try {
      setAllowed(await window.api.lan.pair(address, name || address))
    } catch (failure) {
      setError(ipcMessage(failure))
      setCode(undefined)
    } finally {
      setBusy(false)
    }
  }

  async function confirm(matched: boolean): Promise<void> {
    setError('')
    try {
      const host = await window.api.lan.confirmPair(matched)
      if (host) return onPaired(host)
      setAllowed(undefined)
      setCode(undefined)
      setError(
        `Nothing was kept. On ${address}, remove this computer under Settings → Connections → ` +
          'Devices, since it was allowed there.'
      )
    } catch (failure) {
      setError(ipcMessage(failure))
    }
  }

  const footer = allowed ? (
    <>
      <Button onClick={() => void confirm(false)}>No, they differ</Button>
      <Button variant="primary" onClick={() => void confirm(true)}>
        Yes, it matched
      </Button>
    </>
  ) : (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={busy || !address.trim()} onClick={() => void connect()}>
        {busy ? 'Waiting…' : 'Connect'}
      </Button>
    </>
  )

  return (
    <Modal
      title="Add a computer"
      subtitle="Another computer on this network, or on a VPN you share, running Styr."
      onClose={onClose}
      backdropCloses={!busy && !allowed}
      onSubmit={busy || allowed ? undefined : () => void connect()}
      footer={footer}
    >
      {allowed ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center" aria-live="polite">
          <span className="text-[12.5px] text-dim">
            {allowed.name} allowed this computer. Did it show this code?
          </span>
          <span
            className="font-mono text-[28px] font-semibold tracking-[0.12em] text-ink"
            aria-label={`Code ${allowed.code}`}
          >
            {groupedCode(allowed.code)}
          </span>
          <Hint>
            Only a yes keeps it. If the codes differed, something else answered or is in between:
            say no, and nothing is kept here.
          </Hint>
        </div>
      ) : busy && code ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center" aria-live="polite">
          <span className="text-[12.5px] text-dim">
            On {address}, allow this computer in Settings → Connections, after checking it shows
          </span>
          <span
            className="font-mono text-[28px] font-semibold tracking-[0.12em] text-ink"
            aria-label={`Code ${code}`}
          >
            {groupedCode(code)}
          </span>
          <Hint>If the codes differ, turn it down there: something else is in between.</Hint>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-dim">Address</span>
            <input
              aria-label="Address"
              className={`${inputClass} font-mono`}
              placeholder="192.168.1.20"
              spellCheck={false}
              autoFocus
              value={address}
              disabled={busy}
              onChange={(event) => setAddress(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-dim">Name</span>
            <input
              aria-label="Name"
              className={inputClass}
              placeholder="Studio"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <Hint>
            On that computer, open Settings → Connections → Add device first: it accepts a new
            computer only while that window is open. Its address is under Network details there.
          </Hint>
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </Modal>
  )
}

/** The workspaces a paired computer shares: open one here, as a remote workspace. */
function OpenWorkspaceDialog({
  host,
  onClose
}: {
  host: LanHostInfo
  onClose: () => void
}): ReactNode {
  const [boards, setBoards] = useState<LanBoard[]>()
  const [error, setError] = useState('')

  useEffect(() => {
    window.api.lan.boards(host.fingerprint).then(setBoards, (failure: unknown) => {
      setError(ipcMessage(failure))
      setBoards([])
    })
  }, [host.fingerprint])

  async function open(board: LanBoard): Promise<void> {
    setError('')
    try {
      await window.api.lan.addWorkspace({
        fingerprint: host.fingerprint,
        workspaceId: board.id,
        name: `${board.name} (${host.name})`
      })
      onClose()
    } catch (failure) {
      setError(ipcMessage(failure))
    }
  }

  return (
    <Modal
      title={`Open a workspace on ${host.name}`}
      subtitle="Only the workspaces it shares are listed."
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {!boards ? (
        <Hint>Asking {host.name}…</Hint>
      ) : boards.length === 0 && !error ? (
        <Hint>
          {host.name} shares no workspace. Switch one on there, under Settings → Connections →
          Shared workspaces.
        </Hint>
      ) : (
        <Card>
          {boards.map((board) => (
            <CardRow key={board.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{board.name}</span>
              {board.linked ? (
                <span className="text-[11.5px] text-faint">Already here</span>
              ) : (
                <Button className="h-[26px] px-2.5" onClick={() => void open(board)}>
                  Open
                </Button>
              )}
            </CardRow>
          ))}
        </Card>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </Modal>
  )
}
