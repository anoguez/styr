import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { WorkspaceOverview } from '@core/types.js'
import { Button, Field, Modal, inputClass } from './ui.js'

/**
 * The navbar's workspace menu. Only the button opts out of window dragging, never a wrapper — a
 * wrapper's empty space would become a dead zone for double-click-to-zoom.
 */
export function WorkspaceSwitcher({
  overview,
  open,
  onOpenChange,
  onSwitch,
  onNew,
  onManage
}: {
  overview: WorkspaceOverview
  open: boolean
  onOpenChange: (open: boolean) => void
  onSwitch: (id: string) => void
  onNew: () => void
  onManage: () => void
}): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const current =
    overview.workspaces.find((workspace) => workspace.id === overview.activeId)?.name ?? 'Default'

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent): void {
      if (!root.current?.contains(event.target as Node)) onOpenChange(false)
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onOpenChange])

  const item =
    'flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[12px] text-dim hover:bg-raised hover:text-ink'

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch workspace"
        className="flex max-w-[180px] items-center gap-1.5 rounded-lg border border-edge-strong px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-raised/70 [-webkit-app-region:no-drag]"
        onClick={() => onOpenChange(!open)}
      >
        <span className="truncate">{current}</span>
        <svg viewBox="0 0 10 10" className="size-[9px] shrink-0 text-dim" aria-hidden>
          <path
            d="M2 3.5 5 6.5 8 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute left-0 top-full z-40 mt-1.5 flex w-60 flex-col gap-0.5 rounded-xl border border-edge-strong bg-panel p-1.5 shadow-[0_16px_40px_-8px_rgba(0,0,0,0.7)] [-webkit-app-region:no-drag]"
        >
          {overview.workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="menuitemradio"
              aria-checked={workspace.id === overview.activeId}
              className={item}
              onClick={() => {
                onOpenChange(false)
                if (workspace.id !== overview.activeId) onSwitch(workspace.id)
              }}
            >
              <span className="truncate">{workspace.name}</span>
              <span className="flex shrink-0 items-center gap-2 text-[11px] text-faint">
                {workspace.taskCount}
                {workspace.id === overview.activeId ? (
                  <span aria-hidden className="text-[var(--color-accent-text)]">
                    ✓
                  </span>
                ) : null}
              </span>
            </button>
          ))}
          <div className="my-1 border-t border-edge" />
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              onOpenChange(false)
              onNew()
            }}
          >
            New workspace…
          </button>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              onOpenChange(false)
              onManage()
            }}
          >
            Manage workspaces…
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** Strips Electron's "Error invoking remote method …" wrapper so a message reads as the app wrote it. */
export function ipcMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function NewWorkspaceDialog({
  onCreate,
  onClose
}: {
  onCreate: (name: string) => Promise<void>
  onClose: () => void
}): ReactNode {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await onCreate(name)
      onClose()
    } catch (failure) {
      setError(ipcMessage(failure))
      setBusy(false)
    }
  }

  return (
    <Modal
      title="New workspace"
      subtitle="A separate board with its own tasks and agents."
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
            Create workspace
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Field
          label="Name"
          hint="You switch to it straight away. The same repo can be used in any workspace."
        >
          <input
            autoFocus
            className={inputClass}
            value={name}
            maxLength={40}
            placeholder="Client A"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {error ? <p className="mt-3 text-[12px] text-danger">{error}</p> : null}
      </form>
    </Modal>
  )
}
