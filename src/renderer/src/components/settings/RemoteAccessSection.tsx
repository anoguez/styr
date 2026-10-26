import { useEffect, useState, type ReactNode } from 'react'
import type { AccessPairing, AccessState } from '@core/types.js'
import {
  deviceLine,
  groupedFingerprint,
  interfaceOptions,
  listenerStatus,
  qrPath
} from '../../lib/accessView.js'
import { ipcMessage } from '../../lib/ipcMessage.js'
import { Button, Card, CardRow, Field, Hint, Select, SwitchRow, inputClass } from '../ui.js'

/**
 * Settings → Remote devices (all workspaces): lets devices you pair reach this computer over a
 * private network (`docs/architecture/remote-access.md`). Off until switched on, and then only on
 * one private address you pick. Which workspaces they may open is decided per workspace, under
 * Settings → Remote access (`WorkspaceSharingSection`). These controls act at once, like Remote
 * hosts: they are not part of Save.
 */
export function RemoteAccessSection(): ReactNode {
  const [state, setState] = useState<AccessState>()
  const [error, setError] = useState('')
  const [pairing, setPairing] = useState<AccessPairing>()
  const [port, setPort] = useState('')

  useEffect(() => {
    void window.api.access.state().then((initial) => {
      setState(initial)
      setPort(String(initial.port))
    })
    return window.api.access.onChanged(setState)
  }, [])

  // The QR is good for two minutes; it comes off the screen when it stops working or is scanned.
  useEffect(() => {
    if (!pairing) return
    const left = pairing.expiresAt - Date.now()
    if (left <= 0) return setPairing(undefined)
    const timer = setTimeout(() => setPairing(undefined), left)
    return () => clearTimeout(timer)
  }, [pairing])
  useEffect(() => {
    if (pairing && state && !state.pairingExpiresAt) setPairing(undefined)
  }, [pairing, state])

  if (!state) return null

  async function configure(
    patch: Parameters<typeof window.api.access.configure>[0]
  ): Promise<void> {
    setError('')
    try {
      setState(await window.api.access.configure(patch))
    } catch (failure) {
      setError(ipcMessage(failure))
    }
  }

  async function pair(): Promise<void> {
    setError('')
    try {
      setPairing(await window.api.access.pair())
    } catch (failure) {
      setError(ipcMessage(failure))
    }
  }

  function cancelPairing(): void {
    setPairing(undefined)
    void window.api.access.cancelPair()
  }

  const options = interfaceOptions(state)
  const now = Date.now()

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SwitchRow
          label="Allow other devices to connect"
          hint="Opens a listener in this app so devices you pair can use the workspaces you share. Reached over Tailscale (or an ssh tunnel to this computer) only; nothing else is allowed. Quitting Styr, or this Mac sleeping, ends the connection."
          checked={state.enabled}
          onChange={(enabled) => void configure({ enabled })}
        />
        <CardRow className="flex flex-col gap-3 px-3.5 py-3">
          <Field label="Listen on">
            <Select
              aria-label="Network interface to listen on"
              value={state.bindAddress}
              onChange={(event) => void configure({ bindAddress: event.target.value })}
            >
              <option value="">Pick an interface…</option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Port">
            <input
              aria-label="Port"
              className={`${inputClass} w-28`}
              inputMode="numeric"
              value={port}
              onChange={(event) => setPort(event.target.value.replace(/\D/g, '').slice(0, 5))}
              onBlur={() => {
                const next = Number(port)
                if (next !== state.port) void configure({ port: next })
              }}
            />
          </Field>
          {state.error ? (
            <span role="alert" className="text-[12px] text-danger">
              {state.error}
            </span>
          ) : (
            <Hint>{listenerStatus(state)}</Hint>
          )}
          {error ? (
            <span role="alert" className="text-[12px] text-danger">
              {error}
            </span>
          ) : null}
        </CardRow>
        <SwitchRow
          label="Keep this Mac awake while a device is connected"
          hint="Stops the computer sleeping while a paired device is connected, so a task started from the phone is not cut off. Released when the last device leaves."
          checked={state.keepAwake}
          onChange={(keepAwake) => void configure({ keepAwake })}
        />
      </Card>

      <div className="flex flex-col gap-2.5">
        <span className="text-[12px] font-semibold text-dim">Paired devices</span>
        <Card>
          {state.devices.length === 0 ? (
            <CardRow className="px-3.5 py-3">
              <Hint>No devices yet. Pair one with the QR below.</Hint>
            </CardRow>
          ) : (
            state.devices.map((device) => (
              <CardRow key={device.id} className="flex items-center gap-3 px-3.5 py-2.5">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[12.5px] font-medium text-ink">{device.name}</span>
                  <span className="truncate font-mono text-[10.5px] text-faint">
                    {deviceLine(device, now)}
                  </span>
                </span>
                <Button
                  variant="danger"
                  className="h-[26px] px-2.5"
                  title="Removes the device and ends its connections. Pairing it again needs a new QR."
                  onClick={() => {
                    if (window.confirm(`Revoke ${device.name}? It will have to be paired again.`)) {
                      void window.api.access.revoke(device.id).then(setState)
                    }
                  }}
                >
                  Revoke
                </Button>
              </CardRow>
            ))
          )}
        </Card>
        <div className="flex flex-col gap-2">
          {pairing ? (
            <PairingCode pairing={pairing} onCancel={cancelPairing} />
          ) : (
            <Button
              className="self-start"
              disabled={!state.listening}
              title={state.listening ? undefined : 'Turn on Remote access and pick an interface.'}
              onClick={() => void pair()}
            >
              Pair a device…
            </Button>
          )}
          <Hint>
            Scan the QR with the Styr app once. The phone keeps its own key and signs in by itself
            after that, until you revoke it here.
          </Hint>
        </div>
      </div>

      <Field
        label="This computer's fingerprint"
        hint="The phone checks it on every connection, so it never sends anything to an impostor on the network."
      >
        <code className="break-words font-mono text-[11px] text-dim">
          {groupedFingerprint(state.fingerprint)}
        </code>
      </Field>
    </div>
  )
}

/** The QR on a white plate: a code needs the same contrast whatever the theme. */
function PairingCode({
  pairing,
  onCancel
}: {
  pairing: AccessPairing
  onCancel: () => void
}): ReactNode {
  const { path, size } = qrPath(pairing.modules)
  return (
    <div className="flex items-start gap-4">
      <svg
        role="img"
        aria-label="Pairing QR code"
        viewBox={`0 0 ${size} ${size}`}
        className="size-44 shrink-0 rounded-lg bg-white text-black"
        shapeRendering="crispEdges"
      >
        <path d={path} fill="currentColor" />
      </svg>
      <div className="flex flex-col gap-2">
        <span className="text-[12.5px] text-ink">Scan this with the Styr app.</span>
        <Hint>
          It works once and stops at{' '}
          {new Date(pairing.expiresAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
          })}
          . It holds the pairing secret, not a login: share it with nobody.
        </Hint>
        <Button className="self-start" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
