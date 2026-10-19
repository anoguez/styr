import { useState, type ReactNode } from 'react'
import { DEFAULT_SERVER_COMMAND, isValidRemoteHost } from '@core/remote.js'
import type { Workspaces } from '../../hooks/useWorkspaces.js'
import { ipcMessage } from '../../lib/ipcMessage.js'
import { connectionLabel, useRemoteState } from '../../lib/remoteStatus.js'
import { Button, Card, CardRow, Field, Hint, inputClass } from '../ui.js'

/**
 * Settings → Remote, behind the experimental flag: each host's connection, and a minimal form that
 * links a workspace on a host that already runs `styr serve`. Acts at once, like Workspaces.
 */
export function RemoteSection({ workspaces }: { workspaces: Workspaces }): ReactNode {
  const state = useRemoteState()
  const linked = workspaces.overview.workspaces.filter((workspace) => workspace.remote)

  return (
    <div className="flex flex-col gap-3">
      {state.hosts.length > 0 ? (
        <Card>
          {state.hosts.map((host) => {
            const names = linked
              .filter((workspace) => workspace.remote?.host === host.host)
              .map((workspace) => workspace.name)
            return (
              <CardRow key={host.host} className="flex items-center gap-3 px-3.5 py-2.5">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[12.5px] font-medium text-ink">
                    {host.host}
                    <span className="ml-2 font-normal text-dim">
                      {host.status === 'connected' ? 'Connected' : connectionLabel(host)}
                    </span>
                  </span>
                  <span className="truncate font-mono text-[10.5px] text-faint">
                    {[
                      names.join(', '),
                      host.serverVersion ? `Styr ${host.serverVersion}` : '',
                      host.serverWorkspace ? `showing ${host.serverWorkspace.name}` : ''
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {host.lastError && host.status !== 'connected' ? (
                    <span className="text-[11px] text-danger">{host.lastError}</span>
                  ) : null}
                </span>
                {host.status === 'connected' || host.status === 'connecting' ? null : (
                  <Button
                    className="h-[26px] px-2.5"
                    onClick={() => void window.api.remote.retry(host.host)}
                  >
                    Retry now
                  </Button>
                )}
              </CardRow>
            )
          })}
        </Card>
      ) : (
        <Hint>No remote workspaces yet.</Hint>
      )}
      <AddRemoteWorkspace workspaces={workspaces} />
    </div>
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
          <span className="text-[12.5px] font-medium text-ink">Add a remote workspace</span>
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
            hint={`What starts styr serve on the host, run by its login shell. Leave empty for “${DEFAULT_SERVER_COMMAND}” on its PATH.`}
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
        The host must already run styr serve, at the same version as this app. Only a link is kept
        on this computer; the tasks, settings and agents stay on the host.
      </Hint>
      {error ? <p className="text-[12px] text-danger">{error}</p> : null}
    </form>
  )
}
