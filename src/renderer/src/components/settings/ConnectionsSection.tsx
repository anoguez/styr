import { useEffect, useState, type ReactNode } from 'react'
import type { AccessConfigPatch, AccessState, WorkspaceOverview } from '@core/types.js'
import {
  SHIELDS_UP_WARNING,
  connectionSummary,
  deviceLine,
  groupedFingerprint,
  interfaceLabel,
  listenerStatus,
  needsSharedWorkspace,
  showShieldsUpWarning
} from '../../lib/accessView.js'
import { ipcMessage } from '../../lib/ipcMessage.js'
import { PlusIcon } from '../icons.js'
import { Button, Card, CardRow, Eyebrow, Hint, Segmented, Switch, SwitchRow } from '../ui.js'
import { AddDeviceDialog, ConnectIntroDialog, DevicesGlyph } from './ConnectDialogs.js'
import { OtherComputersPane } from './OtherComputersPane.js'

type Dialog = 'intro' | 'add'

type Tab = 'this' | 'others'

/**
 * Settings → Connections (all workspaces), two ways round: This computer, which devices you pair
 * reach from the same network or a VPN it is on, and Other computers, whose shared workspaces this
 * one opens (`docs/architecture/remote-access.md`). Every control acts at once, like Remote hosts:
 * none of it waits for Save.
 */
export function ConnectionsSection({
  openWorkspaceId,
  onSharedChange,
  remoteEnabled,
  overview,
  onOpenExperimental
}: {
  openWorkspaceId: string
  onSharedChange: (workspaceId: string, shared: boolean) => void
  remoteEnabled: boolean
  overview: WorkspaceOverview
  onOpenExperimental: () => void
}): ReactNode {
  const [tab, setTab] = useState<Tab>('this')
  return (
    <div className="flex flex-col gap-5">
      <Segmented
        label="Connections"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'this', label: 'This computer' },
          { value: 'others', label: 'Other computers' }
        ]}
      />
      {tab === 'this' ? (
        <ThisComputerPane openWorkspaceId={openWorkspaceId} onSharedChange={onSharedChange} />
      ) : (
        <OtherComputersPane
          remoteEnabled={remoteEnabled}
          overview={overview}
          onOpenExperimental={onOpenExperimental}
        />
      )}
    </div>
  )
}

/** Devices you pair reach this computer: one switch, the devices, and what they may open. */
function ThisComputerPane({
  openWorkspaceId,
  onSharedChange
}: {
  /** The workspace the window shows: offered first when a device is added and nothing is shared. */
  openWorkspaceId: string
  /** A workspace's `remoteAccess` was saved, so the dialog's draft can agree with the file. */
  onSharedChange: (workspaceId: string, shared: boolean) => void
}): ReactNode {
  const [state, setState] = useState<AccessState>()
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<Dialog>()

  useEffect(() => {
    void window.api.access.state().then(setState)
    // Shields Up is asked about when the page opens (and by the service when switched on), not
    // polled: the answer comes back through `access:changed`.
    void window.api.access.checkNetwork().catch(() => undefined)
    return window.api.access.onChanged(setState)
  }, [])

  if (!state) return null

  async function configure(patch: AccessConfigPatch): Promise<AccessState> {
    const next = await window.api.access.configure(patch)
    setState(next)
    return next
  }

  async function toggle(patch: AccessConfigPatch): Promise<void> {
    setError('')
    try {
      await configure(patch)
    } catch (failure) {
      setError(ipcMessage(failure))
    }
  }

  async function share(workspaceId: string, shared: boolean): Promise<void> {
    setState(await window.api.access.setShared(workspaceId, shared))
    onSharedChange(workspaceId, shared)
  }

  async function toggleShare(workspaceId: string, shared: boolean): Promise<void> {
    setError('')
    try {
      await share(workspaceId, shared)
    } catch (failure) {
      setError(ipcMessage(failure))
    }
  }

  /** Add device: the intro first while access is off, since adding means switching it on. */
  const addDevice = (): void => setDialog(state.enabled && state.listening ? 'add' : 'intro')
  const firstRun = !state.enabled && state.devices.length === 0
  const now = Date.now()

  return (
    <div className="flex flex-col gap-5">
      {showShieldsUpWarning(state) ? <Notice>{SHIELDS_UP_WARNING}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}

      {firstRun ? (
        <Card className="items-center gap-3 px-6 py-8 text-center">
          <DevicesGlyph />
          <span className="max-w-sm text-[12.5px] leading-relaxed text-dim">
            Use this computer&apos;s workspaces from your phone or another computer on the same
            network.
          </span>
          {state.error ? (
            <span role="alert" className="text-[12px] text-danger">
              {state.error}
            </span>
          ) : null}
          <Button variant="primary" onClick={() => setDialog('intro')}>
            Get started
          </Button>
        </Card>
      ) : (
        <Card>
          <SwitchRow
            label="Allow devices on your network to connect"
            hint="From the same Wi-Fi or office network as this computer, or a VPN it is on such as Tailscale. Never from the internet."
            checked={state.enabled}
            onChange={(enabled) => void toggle({ enabled })}
          />
          <CardRow className="flex flex-col gap-2 px-3.5 py-3">
            <span className="text-[12px] font-medium text-ink">{connectionSummary(state)}</span>
            {state.error ? (
              <span role="alert" className="text-[12px] text-danger">
                {state.error}
              </span>
            ) : (
              <Hint>{listenerStatus(state)}</Hint>
            )}
          </CardRow>
          <SwitchRow
            label="Keep this computer awake while a device is connected"
            hint="Stops the computer sleeping while a paired device is connected, so a task started from the phone is not cut off. Released when the last device leaves."
            checked={state.keepAwake}
            onChange={(keepAwake) => void toggle({ keepAwake })}
          />
        </Card>
      )}

      <section className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <Eyebrow>Devices</Eyebrow>
          <Button className="h-[26px] px-2.5" onClick={addDevice}>
            <PlusIcon size={12} />
            Add device
          </Button>
        </div>
        <Card>
          {state.devices.length === 0 ? (
            <CardRow className="px-3.5 py-3">
              <Hint>No devices yet. Add one with the Styr app and a QR code.</Hint>
            </CardRow>
          ) : (
            state.devices.map((device) => (
              <CardRow key={device.id} className="flex items-center gap-3 px-3.5 py-2.5">
                <span
                  aria-hidden
                  className={`size-2 shrink-0 rounded-full ${device.connected ? 'bg-accent' : 'bg-edge-strong'}`}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[12.5px] font-medium text-ink">{device.name}</span>
                  <span className="truncate font-mono text-[10.5px] text-faint">
                    {deviceLine(device, now)}
                  </span>
                </span>
                <Button
                  variant="danger"
                  className="h-[26px] px-2.5"
                  title="Removes the device and ends its connections at once. Adding it again needs a new QR code."
                  onClick={() => {
                    if (window.confirm(`Remove ${device.name}? It will have to be added again.`)) {
                      void window.api.access.revoke(device.id).then(setState)
                    }
                  }}
                >
                  Remove
                </Button>
              </CardRow>
            ))
          )}
        </Card>
      </section>

      {state.workspaces.length > 0 ? (
        <section className="flex flex-col gap-2.5">
          <Eyebrow>Shared workspaces</Eyebrow>
          <Card>
            {state.workspaces.map((workspace) => (
              <CardRow key={workspace.id} className="flex items-center gap-3 px-3.5 py-2.5">
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                  {workspace.name}
                </span>
                <Switch
                  checked={workspace.shared}
                  label={`Share ${workspace.name} with paired devices`}
                  onChange={(shared) => void toggleShare(workspace.id, shared)}
                />
              </CardRow>
            ))}
          </Card>
          {needsSharedWorkspace(state) ? (
            <span role="alert" className="text-[11.5px] text-danger">
              Nothing is shared, so your devices have nothing to open.
            </span>
          ) : (
            <Hint>
              Paired devices can open, and run commands in, only the workspaces switched on here.
              Switching one off closes what a device has open in it.
            </Hint>
          )}
        </section>
      ) : null}

      {state.enabled && (state.interfaces.length > 0 || state.fingerprint !== undefined) ? (
        <details className="group text-[12px] text-dim">
          <summary className="cursor-pointer select-none text-faint hover:text-dim">
            Network details
          </summary>
          <div className="mt-2.5 flex flex-col gap-2 pl-3">
            {state.listening ? <span className="text-faint">Port {state.port}</span> : null}
            {state.interfaces.map((entry) => (
              <span key={`${entry.name}-${entry.address}`} className="font-mono text-[11px]">
                {interfaceLabel(entry)}
              </span>
            ))}
            {state.fingerprint !== undefined ? (
              <span className="flex flex-col gap-0.5">
                <span className="text-faint">This computer&apos;s fingerprint</span>
                <code className="break-words font-mono text-[11px]">
                  {groupedFingerprint(state.fingerprint)}
                </code>
              </span>
            ) : null}
          </div>
        </details>
      ) : null}

      {dialog === 'intro' ? (
        <ConnectIntroDialog
          onLater={() => setDialog(undefined)}
          onStart={async () => {
            const next = await configure({ enabled: true })
            if (!next.listening) throw new Error(next.error ?? 'Could not start listening.')
            setDialog('add')
          }}
        />
      ) : null}
      {dialog === 'add' ? (
        <AddDeviceDialog
          state={state}
          openWorkspaceId={openWorkspaceId}
          onShare={share}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </div>
  )
}

function Notice({ children }: { children: ReactNode }): ReactNode {
  return (
    <Card>
      <CardRow className="px-3.5 py-3">
        <span role="alert" className="text-[12px] text-danger">
          {children}
        </span>
      </CardRow>
    </Card>
  )
}
