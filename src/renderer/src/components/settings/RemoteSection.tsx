import { useState, type ReactNode } from 'react'
import { DEFAULT_SERVER_COMMAND, isValidRemoteHost } from '@core/remote.js'
import type { RemoteHostState } from '@core/types.js'
import type { Workspaces } from '../../hooks/useWorkspaces.js'
import { ipcMessage } from '../../lib/ipcMessage.js'
import { stopServer, upgradeServer } from '../../lib/remoteActions.js'
import { connectionLabel, uptime, useRemoteState } from '../../lib/remoteStatus.js'
import { Button, Card, CardRow, Field, Hint, inputClass } from '../ui.js'

/**
 * Settings → Remote hosts, behind the experimental flag: each host in use with its server's
 * version, connection and uptime, and Disconnect / Connect, Upgrade server and Stop server. A
 * restart or stop ends the server's agents, so both ask first and list them (warn, don't refuse);
 * nothing restarts the server unasked. Below, a form that links a workspace a host already has
 * (another computer's, say); New workspace → Remote sets a host up from scratch.
 */
export function RemoteSection({ workspaces }: { workspaces: Workspaces }): ReactNode {
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
      ) : (
        <Hint>No remote hosts yet. Set one up with New workspace → Remote host.</Hint>
      )}
      <AddRemoteWorkspace workspaces={workspaces} />
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

function AddRemoteWorkspace({ workspaces }: { workspaces: Workspaces }): ReactNode {
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [remoteId, setRemoteId] = useState('default')
  const [server, setServer] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const hostOk = isValidRemoteHost(host.trim())

  async function add(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      workspaces.apply(
        await window.api.remote.addWorkspace({
          name,
          host: host.trim(),
          workspaceId: remoteId.trim(),
          ...(server.trim() ? { server: server.trim() } : {})
        })
      )
      setName('')
      setHost('')
      setServer('')
    } catch (failure) {
      setError(ipcMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        void add()
      }}
    >
      <Card>
        <CardRow className="flex flex-col gap-3 px-3.5 py-3">
          <span className="text-[12.5px] font-medium text-ink">
            Link a workspace a host already has
          </span>
          <Field label="Name" hint="How it reads in the workspace switcher, on this computer only.">
            <input
              className={inputClass}
              value={name}
              maxLength={40}
              placeholder="Devbox"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field
            label="Host"
            hint="Whatever ssh accepts: an alias from ~/.ssh/config or user@address. Styr runs ssh in batch mode, so it never asks for a password; set up a key or Tailscale SSH first."
          >
            <input
              className={inputClass}
              value={host}
              spellCheck={false}
              placeholder="me@100.64.0.2"
              onChange={(event) => setHost(event.target.value)}
            />
          </Field>
          <Field
            label="Workspace on the host"
            hint="Its id on the server: “default”, or the folder name under workspaces/."
          >
            <input
              className={inputClass}
              value={remoteId}
              spellCheck={false}
              onChange={(event) => setRemoteId(event.target.value)}
            />
          </Field>
          <Field
            label="Server command"
            hint={`What starts styr serve on the host, run by its login shell. Leave empty for “${DEFAULT_SERVER_COMMAND}”, where setup and install.sh put it.`}
          >
            <input
              className={inputClass}
              value={server}
              spellCheck={false}
              placeholder={DEFAULT_SERVER_COMMAND}
              onChange={(event) => setServer(event.target.value)}
            />
          </Field>
        </CardRow>
      </Card>
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !name.trim() || !hostOk || !remoteId.trim()}
        >
          Add and open
        </Button>
        {host.trim() && !hostOk ? (
          <span className="text-[12px] text-danger">That is not a host ssh can reach.</span>
        ) : null}
      </div>
      <Hint>
        For a workspace that already lives on a host, such as one set up from another computer. To
        set up a new host, use New workspace → Remote host. Only a link is kept on this computer;
        the tasks, settings and agents stay on the host.
      </Hint>
      {error ? <p className="text-[12px] text-danger">{error}</p> : null}
    </form>
  )
}
