import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AccessDevice, AccessPairing, AccessState } from '@core/types.js'
import {
  groupedFingerprint,
  initialShareChoice,
  newlyPaired,
  qrPath
} from '../../lib/accessView.js'
import { ipcMessage } from '../../lib/ipcMessage.js'
import { Icon } from '../icons.js'
import { Button, Card, CardRow, Checkbox, Hint, Modal } from '../ui.js'

/** A phone and a laptop with a link between them: what this page connects. */
export function DevicesGlyph({ size = 28 }: { size?: number }): ReactNode {
  return (
    <span className="flex items-center gap-1.5 text-dim" aria-hidden>
      <Icon size={size}>
        <rect x="5" y="2" width="6" height="12" rx="1.25" />
        <path d="M7.25 12h1.5" />
      </Icon>
      <Icon size={size * 0.6}>
        <path d="M3 8h1M7.5 8h1M12 8h1" />
      </Icon>
      <Icon size={size}>
        <rect x="2.5" y="3.5" width="11" height="7" rx="1" />
        <path d="M1 12.5h14" />
      </Icon>
    </span>
  )
}

const PhoneIcon = (): ReactNode => (
  <Icon size={16}>
    <rect x="5" y="2" width="6" height="12" rx="1.25" />
    <path d="M7.25 12h1.5" />
  </Icon>
)
const BellIcon = (): ReactNode => (
  <Icon size={16}>
    <path d="M4.5 11V7.5a3.5 3.5 0 0 1 7 0V11l1 1.5h-9z" />
    <path d="M6.75 14a1.5 1.5 0 0 0 2.5 0" />
  </Icon>
)
const LockIcon = (): ReactNode => (
  <Icon size={16}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </Icon>
)

const INTRO = [
  {
    icon: <PhoneIcon />,
    title: 'Pick up where you left off',
    body: "Open a shared workspace's board, agents and terminals from your phone or another computer."
  },
  {
    icon: <BellIcon />,
    title: 'Stay in the loop',
    body: 'See when an agent finishes or needs you, without walking back to your desk.'
  },
  {
    icon: <LockIcon />,
    title: 'Private by design',
    body: 'Only from your own network or VPN, never the internet; only devices you pair; only the workspaces you choose. Everything is end-to-end encrypted.'
  }
]

/**
 * What connecting a device gives, shown before access is first switched on. "Get started"
 * switches it on; "Later" changes nothing.
 */
export function ConnectIntroDialog({
  onStart,
  onLater
}: {
  /** Switches access on; rejects with the reason it could not. */
  onStart: () => Promise<void>
  onLater: () => void
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function start(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await onStart()
    } catch (failure) {
      setError(ipcMessage(failure))
      setBusy(false)
    }
  }

  return (
    <Modal title="Connect a device to this computer" onClose={onLater} bare compact>
      <div className="flex flex-col items-center gap-2 border-b border-edge bg-chrome px-8 pb-6 pt-8 text-center">
        <DevicesGlyph size={34} />
        <h2 className="mt-3 text-[16px] font-semibold tracking-[-0.01em] text-ink">
          Connect a device to this computer
        </h2>
        <p className="max-w-sm text-[12.5px] leading-relaxed text-dim">
          Use Styr from your phone or another computer on the same network as this one.
        </p>
      </div>
      <ul className="flex flex-col gap-4 px-8 py-6">
        {INTRO.map((item) => (
          <li key={item.title} className="flex items-start gap-3.5">
            <span className="mt-0.5 text-dim">{item.icon}</span>
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium text-ink">{item.title}</span>
              <span className="text-[12px] leading-relaxed text-faint">{item.body}</span>
            </span>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="px-8 pb-2 text-[12px] text-danger">
          {error}
        </p>
      ) : null}
      <footer className="flex items-center justify-center gap-2 px-8 pb-7 pt-1">
        <Button onClick={onLater}>Later</Button>
        <Button variant="primary" disabled={busy} onClick={() => void start()}>
          {busy ? 'Starting…' : 'Get started'}
        </Button>
      </footer>
    </Modal>
  )
}

type Step = 'share' | 'code' | 'done'

/**
 * Adds one device: which workspaces it may open (asked only while none is shared, so it never
 * pairs into nothing), then the QR, then who paired. The QR's secret works once, for two minutes;
 * closing the dialog before a device has used it withdraws it.
 */
export function AddDeviceDialog({
  state,
  openWorkspaceId,
  onShare,
  onClose
}: {
  state: AccessState
  /** The workspace the window shows, offered first when nothing is shared. */
  openWorkspaceId: string
  /** Shares (or stops sharing) a workspace; rejects with the reason. */
  onShare: (workspaceId: string, shared: boolean) => Promise<void>
  onClose: () => void
}): ReactNode {
  const [step, setStep] = useState<Step>(state.workspaceShared ? 'code' : 'share')
  const [choice, setChoice] = useState(() => initialShareChoice(state.workspaces, openWorkspaceId))
  const [pairing, setPairing] = useState<AccessPairing>()
  const [expired, setExpired] = useState(false)
  const [paired, setPaired] = useState<AccessDevice>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // The devices there when the dialog opened: one that appears after is the one that paired.
  const before = useRef(new Set(state.devices.map((device) => device.id)))
  const offerOpen = useRef(false)

  // Withdraw an offer nobody used when the dialog goes, however it goes.
  useEffect(
    () => () => {
      if (offerOpen.current) void window.api.access.cancelPair()
    },
    []
  )

  async function newCode(): Promise<void> {
    setError('')
    setExpired(false)
    try {
      const next = await window.api.access.pair()
      offerOpen.current = true
      setPairing(next)
    } catch (failure) {
      setError(ipcMessage(failure))
    }
  }

  useEffect(() => {
    if (step === 'code' && !pairing && !error) void newCode()
  }, [step, pairing, error])

  // The QR stops working at its expiry; one timer for that instant.
  useEffect(() => {
    if (!pairing || step !== 'code') return
    const left = pairing.expiresAt - Date.now()
    const timer = setTimeout(
      () => {
        offerOpen.current = false
        setExpired(true)
      },
      Math.max(0, left)
    )
    return () => clearTimeout(timer)
  }, [pairing, step])

  useEffect(() => {
    const device = newlyPaired(before.current, state.devices)
    if (device && step === 'code') {
      offerOpen.current = false
      setPaired(device)
      setStep('done')
    }
  }, [state.devices, step])

  async function confirmShare(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      for (const workspace of state.workspaces) {
        const wanted = choice.has(workspace.id)
        if (wanted !== workspace.shared) await onShare(workspace.id, wanted)
      }
      setStep('code')
    } catch (failure) {
      setError(ipcMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const title =
    step === 'share' ? 'Choose what it can open' : step === 'code' ? 'Add a device' : 'Device added'

  return (
    <Modal
      title={title}
      subtitle={
        step === 'share'
          ? 'A paired device can open only the workspaces you share. You can change this any time.'
          : undefined
      }
      onClose={onClose}
      backdropCloses={step !== 'code'}
      footer={
        step === 'share' ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={busy || choice.size === 0}
              title={choice.size === 0 ? 'Share at least one workspace.' : undefined}
              onClick={() => void confirmShare()}
            >
              Continue
            </Button>
          </>
        ) : step === 'done' ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <Button onClick={onClose}>Cancel</Button>
        )
      }
    >
      {step === 'share' ? (
        <Card>
          {state.workspaces.map((workspace) => (
            <CardRow key={workspace.id} className="px-3.5 py-2.5">
              <Checkbox
                checked={choice.has(workspace.id)}
                onChange={(checked) =>
                  setChoice((current) => {
                    const next = new Set(current)
                    if (checked) next.add(workspace.id)
                    else next.delete(workspace.id)
                    return next
                  })
                }
                label={workspace.name}
              />
            </CardRow>
          ))}
        </Card>
      ) : null}

      {step === 'code' ? (
        <div className="flex flex-col items-center gap-4 text-center">
          {pairing && !expired ? (
            <PairingCode pairing={pairing} />
          ) : (
            <div className="grid size-48 place-items-center rounded-xl border border-dashed border-edge-strong text-[12px] text-faint">
              {expired ? 'This code expired.' : error ? 'No code.' : 'Making a code…'}
            </div>
          )}
          <div className="flex max-w-sm flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink">
              Scan this with the Styr app on your device
            </span>
            <Hint>
              The device must be on the same network as this computer, or on its VPN. The code works
              once and for two minutes; it is a key to this computer, so show it to nobody else.
            </Hint>
            {state.fingerprint ? (
              <Hint>
                This computer&apos;s fingerprint starts{' '}
                <code className="font-mono text-dim">
                  {groupedFingerprint(state.fingerprint).split(' ').slice(0, 2).join(' ')}
                </code>
                .
              </Hint>
            ) : null}
          </div>
          {expired || error ? (
            <Button onClick={() => void newCode()}>New code</Button>
          ) : (
            <span className="text-[11.5px] text-faint" aria-live="polite">
              Waiting for the device…
            </span>
          )}
        </div>
      ) : null}

      {step === 'done' && paired ? (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <DevicesGlyph size={30} />
          <span className="text-[14px] font-medium text-ink">{paired.name} is connected</span>
          <Hint>
            It signs in by itself from now on, whenever it is on this computer&apos;s network.
            Remove it under Devices to stop that.
          </Hint>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-center text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </Modal>
  )
}

/** The QR on a white plate: a code needs the same contrast whatever the theme. */
function PairingCode({ pairing }: { pairing: AccessPairing }): ReactNode {
  const { path, size } = qrPath(pairing.modules)
  return (
    <svg
      role="img"
      aria-label="Pairing QR code"
      viewBox={`0 0 ${size} ${size}`}
      className="size-48 shrink-0 rounded-xl bg-white text-black"
      shapeRendering="crispEdges"
    >
      <path d={path} fill="currentColor" />
    </svg>
  )
}
