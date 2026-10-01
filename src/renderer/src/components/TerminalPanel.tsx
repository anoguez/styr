import { useEffect, useRef, type ReactNode } from 'react'
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
import { AGENT_STATE_LABELS, type AgentStatus } from '@core/agentState.js'
import type { ShortcutBindings, TerminalSessionInfo, ThemeSettings } from '@core/types.js'
import { AGENT_TONE } from '../lib/agentTone.js'
import { Button } from './ui.js'
import { TerminalView } from './TerminalView.js'
import { sessionLabel, type SessionLabel } from '../lib/sessionLabel.js'

function TerminalTab({
  session,
  label,
  agent,
  active,
  onSelect,
  onClose
}: {
  session: TerminalSessionInfo
  label: SessionLabel
  agent?: AgentStatus
  active: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
}): ReactNode {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.id
  })
  const node = useRef<HTMLDivElement | null>(null)

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
      className={`group relative flex shrink-0 cursor-grab items-center gap-2 border-b-2 px-3 py-2 text-[12px] transition-colors active:cursor-grabbing ${
        active ? 'border-accent text-ink' : 'border-transparent text-faint hover:text-dim'
      } ${isDragging ? 'opacity-50' : ''}`}
      {...attributes}
      {...listeners}
    >
      <span
        aria-hidden
        title={agent ? AGENT_STATE_LABELS[agent.state] : undefined}
        className={`size-[6px] shrink-0 rounded-full bg-current ${
          agent ? AGENT_TONE[agent.state] : 'text-edge-strong'
        } ${agent?.state === 'working' ? 'wd-pulse' : ''}`}
      />
      <button
        type="button"
        title={label.detail ? `${label.name}  ·  ${label.detail}` : label.name}
        className="flex min-w-0 items-baseline gap-1.5"
        onClick={() => onSelect(session.id)}
      >
        <span className="max-w-[180px] truncate">{label.name}</span>
        {label.detail ? (
          <span className="shrink-0 font-mono text-[10.5px] text-faint">{label.detail}</span>
        ) : null}
      </button>
      <button
        type="button"
        className="rounded px-0.5 text-faint opacity-0 transition-opacity hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100"
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
  activeId,
  expanded,
  theme,
  bindings,
  taskTitles,
  onToggleExpand,
  onSelect,
  onReorder,
  onNewSession,
  onCloseSession
}: {
  sessions: TerminalSessionInfo[]
  agents: Map<string, AgentStatus>
  activeId: string | null
  expanded: boolean
  theme: ThemeSettings
  bindings: ShortcutBindings
  taskTitles: ReadonlyMap<string, string>
  onToggleExpand: () => void
  onSelect: (id: string) => void
  onReorder: (orderedIds: string[]) => void
  onNewSession: () => void
  onCloseSession: (id: string) => void
}): ReactNode {
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
      <header className="flex items-stretch border-b border-edge">
        <div className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto px-2">
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
                  label={sessionLabel(session, taskTitles)}
                  agent={session.taskId ? agents.get(session.taskId) : undefined}
                  active={session.id === activeId}
                  onSelect={onSelect}
                  onClose={onCloseSession}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-l border-edge px-2 py-1.5">
          <Button variant="subtle" onClick={onNewSession}>
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
              <TerminalView
                sessionId={session.id}
                active={session.id === activeId}
                theme={theme}
                bindings={bindings}
              />
            </div>
          ))
        )}
      </div>
    </section>
  )
}
