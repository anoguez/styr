import { useState, type ReactNode } from 'react'
import { DEFAULT_WORKSPACE_ID } from '@core/types.js'
import type { Workspaces } from '../hooks/useWorkspaces.js'
import { Button, Chip, Field, inputClass } from './ui.js'
import { ipcMessage } from './WorkspaceSwitcher.js'

/**
 * Settings → Workspaces. Acts on the live workspaces rather than the settings draft: creating or
 * deleting one takes effect at once, and Save only covers the other panes.
 */
export function WorkspacesPane({ workspaces }: { workspaces: Workspaces }): ReactNode {
  const { overview, apply } = workspaces
  const [name, setName] = useState('')
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
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col divide-y divide-edge rounded-lg border border-edge-strong">
        {overview.workspaces.map((workspace) => {
          const isDefault = workspace.id === DEFAULT_WORKSPACE_ID
          const editing = renaming?.id === workspace.id
          return (
            <li key={workspace.id} className="flex items-center gap-2 px-3 py-2">
              {editing ? (
                <input
                  autoFocus
                  aria-label={`Rename ${workspace.name}`}
                  className={`${inputClass} py-1`}
                  value={renaming.name}
                  maxLength={40}
                  onChange={(event) => setRenaming({ id: workspace.id, name: event.target.value })}
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
                <span className="min-w-0 flex-1 truncate text-[13px]">{workspace.name}</span>
              )}
              {workspace.id === overview.activeId ? <Chip>Active</Chip> : null}
              <span className="shrink-0 text-[11px] text-faint">
                {workspace.taskCount} task{workspace.taskCount === 1 ? '' : 's'}
              </span>
              {workspace.id === overview.activeId ? null : (
                <Button
                  variant="subtle"
                  onClick={() =>
                    void run(async () => apply(await window.api.workspaces.switch(workspace.id)))
                  }
                >
                  Open
                </Button>
              )}
              {isDefault ? null : (
                <>
                  <Button
                    variant="subtle"
                    onClick={() =>
                      setRenaming(editing ? null : { id: workspace.id, name: workspace.name })
                    }
                  >
                    {editing ? 'Cancel' : 'Rename'}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      const tasks = `${workspace.taskCount} task${workspace.taskCount === 1 ? '' : 's'}`
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
            </li>
          )
        })}
      </ul>

      <Field
        label="New workspace"
        hint="A separate board with its own tasks and agents. The same repo can be used in any of them."
      >
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!name.trim()) return
            void run(async () => apply(await window.api.workspaces.create(name))).then(
              (done) => done && setName('')
            )
          }}
        >
          <input
            className={inputClass}
            value={name}
            maxLength={40}
            placeholder="Client A"
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Create
          </Button>
        </form>
      </Field>
      {error ? <p className="text-[12px] text-danger">{error}</p> : null}
    </div>
  )
}
