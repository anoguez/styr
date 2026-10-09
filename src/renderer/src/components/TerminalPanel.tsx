import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  AGENT_STATE_LABELS,
  runningSubagents,
  subagentCountLabel,
  type AgentStatus
} from '@core/agentState.js'
import type { DiffStat } from '@core/diff.js'
import type {
  ShortcutBindings,
  TerminalRuntimeState,
  TaskStatus,
  TerminalSessionInfo,
  ThemeSettings
} from '@core/types.js'
import { AGENT_TONE } from '../lib/agentTone.js'
import { Button } from './ui.js'
import { TerminalSurface, type TerminalTaskRequest } from './TerminalSurface.js'
import { useTerminalRuntimes } from '../lib/useTerminalRuntimes.js'
import { sessionLabel, type SessionLabel } from '../lib/sessionLabel.js'
import { FILE_MANAGER } from '../lib/platform.js'
import { fileName } from '../lib/terminalPath.js'

const basename = fileName

function TerminalTab({
  session,
  label,
  agent,
  runtime,
  active,
  onSelect,
  onClose
}: {
  session: TerminalSessionInfo
  label: SessionLabel
  agent?: AgentStatus
  runtime?: TerminalRuntimeState
  active: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
}): ReactNode {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.id
  })
  const node = useRef<HTMLDivElement | null>(null)
  // A plain shell has no agent, so its tab reports the shell itself: the program in the foreground
  // and the folder it is in. A task session keeps the label the task gave it.
  const running = session.taskId ? undefined : runtime?.runningCommand
  const name = running ? running.command : label.name
  const subagents = runningSubagents(agent)
  const detail = label.detail || (session.taskId || !runtime ? '' : basename(runtime.cwd))

  useEffect(() => {
    if (active) node.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  return (
    <div
      ref={(element) => {
        setNodeRef(element)
        node.current = element
      }}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`group relative -mb-px flex shrink-0 cursor-grab items-center gap-2 rounded-t-lg border border-b-0 py-0 pl-3.5 pr-3 text-[12.5px] transition-colors active:cursor-grabbing ${
        active
          ? 'border-edge-strong bg-chrome font-medium text-ink shadow-[inset_0_2px_0_var(--color-accent-soft)]'
          : 'border-transparent text-faint hover:text-ink'
      } ${isDragging ? 'opacity-50' : ''}`}
      {...attributes}
      {...listeners}
    >
      <span
        aria-hidden
        title={
          agent
            ? `${AGENT_STATE_LABELS[agent.state]}${subagents ? ` · ${subagentCountLabel(subagents)} running` : ''}`
            : undefined
        }
        className={`size-[6px] shrink-0 rounded-full bg-current ${
          agent ? AGENT_TONE[agent.state] : running ? 'text-col-done' : 'text-edge-strong'
        } ${agent?.state === 'working' ? 'wd-pulse' : ''}`}
      />
      <button
        type="button"
        title={detail ? `${name}  ·  ${detail}` : name}
        className="flex min-w-0 items-baseline gap-1.5"
        onClick={() => onSelect(session.id)}
      >
        <span className="max-w-[180px] truncate">{name}</span>
        {detail ? (
          <span
            className={`shrink-0 font-mono text-[10.5px] font-normal ${active ? 'text-dim' : 'text-faint'}`}
          >
            {detail}
          </span>
        ) : null}
        {subagents ? (
          <span
            title={`${subagentCountLabel(subagents)} running`}
            className={`shrink-0 self-center rounded bg-raised px-1 font-mono text-[10px] font-normal ${AGENT_TONE.working}`}
          >
            +{subagents}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className={`inline-flex size-4 items-center justify-center rounded text-[10px] text-faint transition-opacity hover:bg-raised hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 ${active ? 'opacity-100' : 'opacity-0'}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onClose(session.id)
        }}
        aria-label={`Close ${label.name}`}
      >
        ✕
      </button>
    </div>
  )
}

export function TerminalPanel({
  sessions,
  agents,
  shownAgents,
  activeId,
  expanded,
  theme,
  bindings,
  nativeTerminal,
  taskTitles,
  taskStates,
  diffStats,
  onShowChanges,
  workspaces,
  onToggleExpand,
  onSelect,
  onReorder,
  onNewSession,
  onCloseSession,
  onCreateTask,
  onAskReview,
  onAskFork
}: {
  sessions: TerminalSessionInfo[]
  agents: Map<string, AgentStatus>
  /** `agents` as the views label them (`shownAgents`); `agents` gates the PR and review buttons. */
  shownAgents: Map<string, AgentStatus>
  activeId: string | null
  expanded: boolean
  theme: ThemeSettings
  bindings: ShortcutBindings
  /** `experimental.nativeTerminal`: new terminals try Styr Terminal. */
  nativeTerminal: boolean
  taskTitles: ReadonlyMap<string, string>
  taskStates: ReadonlyMap<string, { status: TaskStatus; prUrl?: string }>
  /** Per-task change totals; a task with no changes has no entry. */
  diffStats: ReadonlyMap<string, DiffStat>
  onShowChanges: (taskId: string) => void
  workspaces: { activeId: string; names: ReadonlyMap<string, string> }
  onToggleExpand: () => void
  onSelect: (id: string) => void
  onReorder: (orderedIds: string[]) => void
  onNewSession: (cwd?: string) => void
  onCloseSession: (id: string) => void
  onCreateTask: (request: TerminalTaskRequest) => Promise<string>
  onAskReview: (taskId: string) => Promise<void>
  onAskFork: (sessionId: string, question: string) => Promise<boolean>
}): ReactNode {
  const runtimes = useTerminalRuntimes(sessions)
  const [fullscreen, setFullscreen] = useState<ReadonlySet<string>>(new Set())
  const setSessionFullscreen = useCallback((id: string, on: boolean) => {
    setFullscreen((current) => {
      if (current.has(id) === on) return current
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const activeRuntime = activeId ? runtimes.get(activeId) : undefined
  // While a full-screen program owns the panel the context bar is gone, so the folder it is in
  // moves up here instead of disappearing.
  const folder =
    activeId && fullscreen.has(activeId) && activeRuntime ? activeRuntime.cwd : undefined

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = sessions.map((session) => session.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    onReorder(arrayMove(ids, from, to))
  }

  return (
    // Focusable and marked so terminal-scoped shortcuts (⌘T) work anywhere in the panel — including
    // its empty state, which has no xterm to take focus. A click on bare panel focuses the section.
    <section
      data-terminal-panel
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col border-t border-edge-strong bg-chrome outline-none"
    >
      <header className="flex h-[42px] items-stretch border-b border-edge bg-[color-mix(in_oklab,var(--color-chrome)_70%,black)]">
        <div className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto overflow-y-hidden px-2">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={sessions.map((session) => session.id)}
              strategy={horizontalListSortingStrategy}
            >
              {sessions.map((session) => (
                <TerminalTab
                  key={session.id}
                  session={session}
                  label={sessionLabel(session, taskTitles, workspaces)}
                  runtime={runtimes.get(session.id)}
                  agent={
                    session.taskId && session.workspaceId === workspaces.activeId
                      ? shownAgents.get(session.taskId)
                      : undefined
                  }
                  active={session.id === activeId}
                  onSelect={onSelect}
                  onClose={onCloseSession}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-l border-edge px-2 py-1.5">
          {folder ? (
            <button
              type="button"
              title={`${folder} — reveal in ${FILE_MANAGER}`}
              className="inline-flex h-6 items-center gap-1.5 rounded-md border border-transparent px-2 font-mono text-[11px] text-dim hover:bg-raised/70 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => void window.api.terminal.revealDirectory(folder)}
            >
              <svg aria-hidden viewBox="0 0 16 16" width="13" height="13">
                <path
                  d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
              {basename(folder)}
            </button>
          ) : null}
          <Button variant="subtle" onClick={() => onNewSession()}>
            + Shell
          </Button>
          <Button
            variant="subtle"
            className="px-2"
            onClick={onToggleExpand}
            title={expanded ? 'Shrink the terminal  (show the board)' : 'Expand the terminal'}
            aria-label={expanded ? 'Shrink the terminal' : 'Expand the terminal'}
            aria-pressed={expanded}
          >
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 8h10" opacity="0.45" />
              {expanded ? (
                <>
                  <path d="M5.4 3.4 8 6l2.6-2.6" />
                  <path d="M5.4 12.6 8 10l2.6 2.6" />
                </>
              ) : (
                <>
                  <path d="M5.4 5.6 8 3l2.6 2.6" />
                  <path d="M5.4 10.4 8 13l2.6-2.6" />
                </>
              )}
            </svg>
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 p-2">
        {sessions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5">
            <p className="text-[12.5px] text-dim">No terminal sessions</p>
            <p className="text-[11.5px] text-faint">
              Start one with <span className="text-dim">+ Shell</span>, or launch Claude from a task
            </p>
          </div>
        ) : (
          sessions.map((session) => (
            <div key={session.id} className="absolute inset-2" hidden={session.id !== activeId}>
              <TerminalSurface
                session={session}
                active={session.id === activeId}
                theme={theme}
                bindings={bindings}
                nativeTerminal={nativeTerminal}
                runtime={runtimes.get(session.id)}
                agentStatus={
                  session.taskId && session.workspaceId === workspaces.activeId
                    ? agents.get(session.taskId)
                    : undefined
                }
                shownState={
                  session.taskId && session.workspaceId === workspaces.activeId
                    ? shownAgents.get(session.taskId)?.state
                    : undefined
                }
                onFullscreenChange={setSessionFullscreen}
                onSplit={onNewSession}
                onCreateTask={onCreateTask}
                taskStatus={
                  session.taskId && session.workspaceId === workspaces.activeId
                    ? taskStates.get(session.taskId)?.status
                    : undefined
                }
                taskPrUrl={
                  session.taskId && session.workspaceId === workspaces.activeId
                    ? taskStates.get(session.taskId)?.prUrl
                    : undefined
                }
                diffStat={
                  session.taskId && session.workspaceId === workspaces.activeId
                    ? diffStats.get(session.taskId)
                    : undefined
                }
                onShowChanges={session.taskId ? () => onShowChanges(session.taskId!) : undefined}
                onAskReview={onAskReview}
                onAskFork={onAskFork}
              />
            </div>
          ))
        )}
      </div>
    </section>
  )
}
