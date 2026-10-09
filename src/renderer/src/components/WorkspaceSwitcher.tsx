import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  WorkspaceAgentActivity,
  WorkspaceBoardSummary,
  WorkspaceOverview,
  WorkspacesActivity
} from '@core/types.js'
import { AGENT_TONE } from '../lib/agentTone.js'
import {
  ACTIVITY_LABELS,
  agentActivityLabel,
  backgroundBadge,
  boardCounts,
  boardSummaryLabel,
  elsewhereNotice,
  type BoardCountGroup
} from '../lib/workspaceStatus.js'
import { Button, Field, Modal, inputClass } from './ui.js'
import { IS_MAC } from '../lib/platform.js'

const COUNT_TONE: Record<BoardCountGroup, string> = {
  needs: AGENT_TONE.waiting,
  running: AGENT_TONE.working,
  next: 'text-faint'
}

/**
 * A workspace row's second line: its most urgent agent and its open Inbox groups. Status is a glyph
 * plus words, never a bare colour dot at the row start — those mark which workspace it is elsewhere.
 */
function WorkspaceStatusLine({
  activity,
  summary
}: {
  activity?: WorkspaceAgentActivity
  summary?: WorkspaceBoardSummary
}): ReactNode {
  const top = activity?.top
  const counts = boardCounts(summary)
  if (!top && counts.length === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10.5px]">
      {top ? (
        <span
          role="img"
          aria-label={`Agents: ${agentActivityLabel(activity)}`}
          className={`size-[6px] shrink-0 rounded-full bg-current ${AGENT_TONE[top]} ${
            top === 'working' ? 'wd-pulse' : ''
          }`}
        />
      ) : null}
      {counts.length > 0 ? (
        counts.map((count, index) => (
          <span key={count.group} className={COUNT_TONE[count.group]}>
            {index > 0 ? <span className="mr-1.5 text-faint">·</span> : null}
            {count.label}
          </span>
        ))
      ) : top ? (
        <span className={AGENT_TONE[top]}>{ACTIVITY_LABELS[top]}</span>
      ) : null}
    </span>
  )
}

function rowTitle(activity?: WorkspaceAgentActivity, summary?: WorkspaceBoardSummary): string {
  const agents = agentActivityLabel(activity)
  return [boardSummaryLabel(summary), agents ? `Agents: ${agents}` : ''].filter(Boolean).join(' — ')
}

/**
 * The navbar's workspace menu. Only the button opts out of window dragging, never a wrapper — a
 * wrapper's empty space would become a dead zone for double-click-to-zoom.
 */
export function WorkspaceSwitcher({
  overview,
  activity,
  open,
  onOpenChange,
  onSwitch,
  onNew,
  onManage
}: {
  overview: WorkspaceOverview
  activity: WorkspacesActivity
  open: boolean
  onOpenChange: (open: boolean) => void
  onSwitch: (id: string) => void
  onNew: () => void
  onManage: () => void
}): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const current =
    overview.workspaces.find((workspace) => workspace.id === overview.activeId)?.name ?? 'Default'
  const badge = backgroundBadge(activity, overview.workspaces)
  const notice = elsewhereNotice(activity, overview.workspaces)
  const [summaries, setSummaries] = useState<Record<string, WorkspaceBoardSummary>>({})

  useEffect(() => {
    if (!open) return
    window.api.workspaces
      .boardSummary()
      .then(setSummaries)
      .catch((error: unknown) => console.error('Could not load workspace summaries:', error))
  }, [open])

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
    <div ref={root} className="relative flex shrink-0 items-center gap-2">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={badge ? `Switch workspace — ${badge.label}` : 'Switch workspace'}
        className="flex max-w-[180px] items-center gap-1.5 rounded-lg border border-edge-strong px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-raised/70 [-webkit-app-region:no-drag]"
        onClick={() => onOpenChange(!open)}
      >
        <span className="truncate">{current}</span>
        {badge?.state === 'working' ? (
          <span className={`flex shrink-0 items-center ${AGENT_TONE.working}`}>
            <span aria-hidden className="size-[7px] rounded-full border-[1.5px] border-current" />
            <span className="sr-only">{badge.label}</span>
          </span>
        ) : null}
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
      {notice ? (
        <button
          type="button"
          title={`${notice.label} — ${notice.targetId ? 'click to switch' : 'click to choose'}`}
          className={`flex max-w-[220px] items-center gap-1.5 rounded-lg bg-[var(--color-col-review)]/15 px-2 py-1 text-[11.5px] font-medium transition-colors hover:bg-[var(--color-col-review)]/25 [-webkit-app-region:no-drag] ${AGENT_TONE.waiting}`}
          onClick={() => {
            if (notice.targetId) onSwitch(notice.targetId)
            else onOpenChange(true)
          }}
        >
          <span aria-hidden className="size-[6px] shrink-0 rounded-full bg-current" />
          <span className="truncate">{notice.text}</span>
          <span className="sr-only">. {notice.label}</span>
        </button>
      ) : null}
      {open ? (
        <div
          role="menu"
          // The switcher sits at the bar's left on macOS and its right elsewhere (the bar is mirrored),
          // so the menu opens toward the middle of the window either way.
          className={`absolute ${IS_MAC ? 'left-0' : 'right-0'} top-full z-40 mt-1.5 flex w-72 flex-col gap-0.5 rounded-xl border border-edge-strong bg-panel p-1.5 shadow-[0_16px_40px_-8px_rgba(0,0,0,0.7)] [-webkit-app-region:no-drag]`}
        >
          {overview.workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="menuitemradio"
              aria-checked={workspace.id === overview.activeId}
              title={
                rowTitle(activity.byWorkspace[workspace.id], summaries[workspace.id]) || undefined
              }
              className={item}
              onClick={() => {
                onOpenChange(false)
                if (workspace.id !== overview.activeId) onSwitch(workspace.id)
              }}
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate">{workspace.name}</span>
                <WorkspaceStatusLine
                  activity={activity.byWorkspace[workspace.id]}
                  summary={summaries[workspace.id]}
                />
              </span>
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
