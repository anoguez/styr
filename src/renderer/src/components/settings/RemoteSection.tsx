import { useState, type ReactNode } from 'react'
import type { RemoteHostState } from '@core/types.js'
import type { Workspaces } from '../../hooks/useWorkspaces.js'
import { ipcMessage } from '../../lib/ipcMessage.js'
import { stopServer, upgradeServer } from '../../lib/remoteActions.js'
import { connectionLabel, uptime, useRemoteState } from '../../lib/remoteStatus.js'
import { Button, Card, CardRow, Hint } from '../ui.js'

/**
 * Settings → Remote hosts (all workspaces), behind the experimental flag: each host in use with
 * its server's version, connection and uptime, and Disconnect / Connect, Upgrade server and Stop
 * server. A restart or stop ends the server's agents, so both ask first and list them (warn, don't
 * refuse); nothing restarts the server unasked. Set up a host… opens New workspace → Remote host
 * (`onSetUp`), the one way to add a remote workspace, a host's existing boards included.
 */
export function RemoteSection({
  workspaces,
  onSetUp
}: {
  workspaces: Workspaces
  /** Settings closes and New workspace opens on Remote host. */
  onSetUp: () => void
}): ReactNode {
  const state = useRemoteState()
  const linked = workspaces.overview.workspaces.filter((workspace) => workspace.remote)

  return (
    <div className="flex flex-col gap-3">
      {state.hosts.length > 0 ? (
        <Card>
          {state.hosts.map((host) => (
            <HostRow
              key={host.host}
              host={host}
              names={linked
                .filter((workspace) => workspace.remote?.host === host.host)
                .map((workspace) => workspace.name)}
            />
          ))}
        </Card>
      ) : null}
      {state.enabled ? (
        <div className="flex flex-col gap-2">
          <Button className="self-start" onClick={onSetUp}>
            Set up a host…
          </Button>
          <Hint>
            {state.hosts.length > 0
              ? 'Adds a remote workspace, on a new host or one already here, as New workspace → Remote host does.'
              : 'No remote hosts yet. Set one up to add a remote workspace, as New workspace → Remote host does.'}
          </Hint>
        </div>
      ) : null}
    </div>
  )
}

function HostRow({ host, names }: { host: RemoteHostState; names: string[] }): ReactNode {
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState('')
  const connected = host.status === 'connected'
  const up = connected ? uptime(host.serverStartedAt, Date.now()) : undefined

  async function act(label: string, work: () => Promise<void>): Promise<void> {
    if (busy) return
    setBusy(label)
    setError('')
    try {
      await work()
    } catch (failure) {
      setError(ipcMessage(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const upgradeTitle = host.upgradeTo
    ? `Install Styr ${host.upgradeTo} on ${host.host} beside ${host.serverVersion ?? 'the running server'}, and restart into it.`
    : host.serverVersion
      ? `${host.host} already runs this app's version (Styr ${host.serverVersion}).`
      : `Connect to ${host.host} to compare versions.`

  return (
    <CardRow className="flex flex-col gap-2 px-3.5 py-2.5">
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[12.5px] font-medium text-ink">
            {host.host}
            <span className="ml-2 font-normal text-dim">
              {connected ? 'Connected' : connectionLabel(host)}
            </span>
          </span>
          <span className="truncate font-mono text-[10.5px] text-faint">
            {[
              names.join(', '),
              host.serverVersion ? `Styr ${host.serverVersion}` : '',
              up ? `up ${up}` : '',
              host.serverWorkspace ? `showing ${host.serverWorkspace.name}` : ''
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {host.upgradeTo ? (
            <span className="text-[11px] text-[var(--color-col-review)]">
              This app is Styr {host.upgradeTo}; the server runs {host.serverVersion}. Upgrade it to
              match.
            </span>
          ) : null}
          {host.lastError && !connected ? (
            <span className="text-[11px] text-danger">{host.lastError}</span>
          ) : null}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {host.userDisconnected || host.status === 'offline' ? (
          <Button
            className="h-[26px] px-2.5"
            disabled={Boolean(busy)}
            onClick={() => void act('connect', () => window.api.remote.connect(host.host))}
          >
            {busy === 'connect' ? 'Connecting…' : 'Connect'}
          </Button>
        ) : (
          <>
            {host.status === 'reconnecting' ? (
              <Button
                className="h-[26px] px-2.5"
                onClick={() => void window.api.remote.retry(host.host)}
              >
                Retry now
              </Button>
            ) : null}
            <Button
              className="h-[26px] px-2.5"
              disabled={Boolean(busy)}
              onClick={() => void act('disconnect', () => window.api.remote.disconnect(host.host))}
            >
              Disconnect
            </Button>
          </>
        )}
        <Button
          className="h-[26px] px-2.5"
          disabled={Boolean(busy) || !host.upgradeTo}
          title={upgradeTitle}
          onClick={() => void act('upgrade', async () => void (await upgradeServer(host.host)))}
        >
          {busy === 'upgrade' ? 'Upgrading…' : 'Upgrade server'}
        </Button>
        <Button
          className="h-[26px] px-2.5"
          disabled={Boolean(busy) || host.userDisconnected}
          title={`Stop the Styr server on ${host.host}, and the agents it runs.`}
          onClick={() => void act('stop', async () => void (await stopServer(host.host)))}
        >
          {busy === 'stop' ? 'Stopping…' : 'Stop server'}
        </Button>
      </div>
      {error ? (
        <pre className="whitespace-pre-wrap font-mono text-[11px] text-danger">{error}</pre>
      ) : null}
    </CardRow>
  )
}
