import { useState, type ReactNode } from 'react'
import { DEFAULT_WORKSPACE_ID } from '@core/types.js'
import type { Workspaces } from '../hooks/useWorkspaces.js'
import { Button, Card, CardRow, Chip, Hint, inputClass } from './ui.js'
import { ipcMessage } from './WorkspaceSwitcher.js'

/**
 * Settings → Workspaces. Acts on the live workspaces rather than the settings draft: creating or
 * deleting one takes effect at once, and Save only covers the other panes.
 */
export function WorkspacesPane({
  workspaces,
  editedWorkspaceId,
  onEdit
}: {
  workspaces: Workspaces
  /** The workspace the dialog is editing, so its row can say so. */
  editedWorkspaceId: string
  /** Point the dialog at a workspace's own settings. */
  onEdit: (id: string) => void
}): ReactNode {
  const { overview, apply } = workspaces
  const [name, setName] = useState('')
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
          return (
            <CardRow key={workspace.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <span
                className={`size-2 shrink-0 rounded-sm ${
                  open ? 'bg-[var(--color-accent-text)]' : 'bg-edge-strong'
                }`}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                {editing ? (
                  <input
                    autoFocus
                    aria-label={`Rename ${workspace.name}`}
                    className={`${inputClass} h-7 py-0`}
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
                <span className="font-mono text-[10.5px] text-faint">{tasks}</span>
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
                      if (
                        window.confirm(
                          `Delete “${workspace.name}” and its ${tasks}? The folder moves to the Trash, so it can be put back.`
                        )
                      ) {
                        void run(async () =>
                          apply(await window.api.workspaces.remove(workspace.id))
                        )
                      }
                    }}
                  >
                    Delete
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
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!name.trim()) return
            void run(async () => apply(await window.api.workspaces.create(name))).then((done) => {
              if (!done) return
              setName('')
              setAdding(false)
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
                setAdding(false)
              }
            }}
          />
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Create
          </Button>
        </form>
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
