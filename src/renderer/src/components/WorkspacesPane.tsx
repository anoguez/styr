import { useState, type ReactNode } from 'react'
import { DEFAULT_WORKSPACE_ID } from '@core/types.js'
import type { Workspaces } from '../hooks/useWorkspaces.js'
import { Button, Card, CardRow, Chip, Hint, inputBase, inputClass } from './ui.js'
import { workspaceColor } from '../lib/workspaceColor.js'
import { ipcMessage } from '../lib/ipcMessage.js'
import { remoteNote, useRemoteState } from '../lib/remoteStatus.js'
import { WorkspacePlace } from './RemoteSetupDialog.js'

/**
 * What Delete asks. A remote workspace's folder here is only a link: removing it touches nothing
 * on the host, which may be unreachable for good.
 */
export function deleteQuestion(
  workspace: { name: string; remote?: { host: string } },
  tasks: string
): string {
  return workspace.remote
    ? `Remove “${workspace.name}” from this computer? Only the local link is deleted. The workspace, its tasks and its agents stay on ${workspace.remote.host}, untouched.`
    : `Delete “${workspace.name}” and its ${tasks}? The folder moves to the Trash, so it can be put back.`
}

/**
 * Settings → Workspaces. Acts on the live workspaces rather than the settings draft: creating or
 * deleting one takes effect at once, and Save only covers the other panes.
 */
export function WorkspacesPane({
  workspaces,
  editedWorkspaceId,
  onEdit,
  onNewRemote
}: {
  workspaces: Workspaces
  /** The workspace the dialog is editing, so its row can say so. */
  editedWorkspaceId: string
  /** Point the dialog at a workspace's own settings. */
  onEdit: (id: string) => void
  /** New workspace → Remote host: Settings closes and the setup dialog opens. */
  onNewRemote: () => void
}): ReactNode {
  const { overview, apply } = workspaces
  const remote = useRemoteState()
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [error, setError] = useState('')

  async function run(work: () => Promise<void>): Promise<boolean> {
    setError('')
    try {
      await work()
      return true
    } catch (failure) {
      setError(ipcMessage(failure))
      return false
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        {overview.workspaces.map((workspace) => {
          const isDefault = workspace.id === DEFAULT_WORKSPACE_ID
          const editing = renaming?.id === workspace.id
          const open = workspace.id === overview.activeId
          const tasks = `${workspace.taskCount} task${workspace.taskCount === 1 ? '' : 's'}`
          const note = remoteNote(remote, workspace)
          const off = Boolean(workspace.remote) && !remote.enabled
          return (
            <CardRow key={workspace.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <span
                aria-hidden
                style={{ backgroundColor: workspaceColor(workspace.id) }}
                className="size-2 shrink-0 rounded-[2px]"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                {editing ? (
                  <input
                    autoFocus
                    aria-label={`Rename ${workspace.name}`}
                    className={`${inputBase} h-7 w-full px-2.5 text-[13px]`}
                    value={renaming.name}
                    maxLength={40}
                    onChange={(event) =>
                      setRenaming({ id: workspace.id, name: event.target.value })
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.stopPropagation()
                        setRenaming(null)
                      }
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void run(async () =>
                          apply(await window.api.workspaces.rename(workspace.id, renaming.name))
                        ).then((done) => done && setRenaming(null))
                      }
                    }}
                  />
                ) : (
                  <span className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
                    <span className="truncate">{workspace.name}</span>
                    {open ? <Chip tone="done">Open now</Chip> : null}
                  </span>
                )}
                <span className="font-mono text-[10.5px] text-faint">
                  {note ? `${note} · ${tasks}` : tasks}
                </span>
              </span>
              {isDefault ? null : (
                <>
                  <Button
                    variant="subtle"
                    className="h-[26px] px-2"
                    onClick={() =>
                      setRenaming(editing ? null : { id: workspace.id, name: workspace.name })
                    }
                  >
                    {editing ? 'Cancel' : 'Rename'}
                  </Button>
                  <Button
                    variant="danger"
                    className="h-[26px] px-2"
                    onClick={() => {
                      if (window.confirm(deleteQuestion(workspace, tasks))) {
                        void run(async () =>
                          apply(await window.api.workspaces.remove(workspace.id))
                        )
                      }
                    }}
                  >
                    {workspace.remote ? 'Remove' : 'Delete'}
                  </Button>
                </>
              )}
              <Button
                variant="subtle"
                className="h-[26px] px-2"
                disabled={workspace.id === editedWorkspaceId}
                onClick={() => onEdit(workspace.id)}
              >
                Edit settings
              </Button>
              {open ? null : (
                <Button
                  className="h-[26px] px-2.5"
                  disabled={off}
                  title={off ? 'Remote workspaces are off (Settings → Experimental).' : undefined}
                  onClick={() =>
                    void run(async () => apply(await window.api.workspaces.switch(workspace.id)))
                  }
                >
                  Open
                </Button>
              )}
            </CardRow>
          )
        })}
      </Card>

      {adding ? (
        <NewWorkspaceForm
          onCreate={(name) => run(async () => apply(await window.api.workspaces.create(name)))}
          onCreated={() => setAdding(false)}
          onCancel={() => setAdding(false)}
          onRemote={onNewRemote}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex h-7 items-center gap-1.5 self-start rounded-[7px] border border-dashed border-edge-strong px-2.5 text-[12px] font-medium text-dim transition-colors hover:border-faint hover:text-ink"
        >
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
          New workspace
        </button>
      )}
      <Hint>
        A separate board with its own tasks and agents. The same repo can be used in any of them.
      </Hint>
      {error ? <p className="text-[12px] text-danger">{error}</p> : null}
    </div>
  )
}

/**
 * Settings → Workspaces → New workspace: a name, created here at once. With remote workspaces on
 * (Experimental) it offers the same "Where the workspace lives" choice as the switcher's dialog;
 * Remote host hands over to that dialog's setup (`onRemote`).
 */
export function NewWorkspaceForm({
  onCreate,
  onCreated,
  onCancel,
  onRemote
}: {
  /** Resolves true once the workspace exists. */
  onCreate: (name: string) => Promise<boolean>
  onCreated: () => void
  onCancel: () => void
  onRemote: () => void
}): ReactNode {
  const remote = useRemoteState()
  const [name, setName] = useState('')
  const form = (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!name.trim()) return
        void onCreate(name).then((done) => {
          if (!done) return
          setName('')
          onCreated()
        })
      }}
    >
      <input
        autoFocus
        aria-label="New workspace name"
        className={inputClass}
        value={name}
        maxLength={40}
        placeholder="Client A"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          }
        }}
      />
      <Button type="submit" variant="primary" disabled={!name.trim()}>
        Create
      </Button>
    </form>
  )
  // With the flag off there is no toggle, and the form stands alone as it always has.
  if (!remote.enabled) return form
  return (
    <div className="flex flex-col gap-2.5">
      <WorkspacePlace
        value="local"
        onChange={(value) => {
          if (value === 'remote') onRemote()
        }}
      />
      {form}
    </div>
  )
}
