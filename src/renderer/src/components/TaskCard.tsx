import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AGENT_STATE_LABELS, type AgentStatus } from '@core/agentState.js'
import { AGENT_TONE } from '../lib/agentTone.js'
import {
  ORCHESTRATION_LANE_LABELS,
  type OrchestrationLane,
  type Task,
  type TaskPriority
} from '@core/types.js'
import type { DiffStat } from '@core/diff.js'
import { Chip, DiffCount } from './ui.js'

const PRIORITY_BAR: Record<TaskPriority, string> = {
  low: 'bg-[var(--color-pri-low)]',
  medium: 'bg-[var(--color-pri-medium)]',
  high: 'bg-[var(--color-pri-high)]',
  urgent: 'bg-[var(--color-pri-urgent)]'
}

export function AgentBadge({ agent }: { agent: AgentStatus }): ReactNode {
  return (
    <span
      className={`ml-auto inline-flex min-w-0 items-center gap-1 whitespace-nowrap ${AGENT_TONE[agent.state]}`}
      title={
        agent.lastMessage ? `${AGENT_STATE_LABELS[agent.state]} — ${agent.lastMessage}` : undefined
      }
    >
      <span
        aria-hidden
        className={`size-[6px] shrink-0 rounded-full bg-current ${
          agent.state === 'working' ? 'wd-pulse' : ''
        }`}
      />
      <span className="truncate">{AGENT_STATE_LABELS[agent.state]}</span>
    </span>
  )
}

export interface QueuedForOrchestration {
  position: number
  lane: OrchestrationLane
}

export function TaskCardBody({
  task,
  agent,
  queued,
  diffStat,
  onShowChanges
}: {
  task: Task
  agent?: AgentStatus
  queued?: QueuedForOrchestration
  diffStat?: DiffStat
  onShowChanges?: () => void
}): ReactNode {
  const meta = [
    task.contextFiles.length > 0 ? `◎ ${task.contextFiles.length}` : null,
    task.activity.length > 0 ? `✎ ${task.activity.length}` : null
  ].filter(Boolean)
  const loud = task.priority === 'high' || task.priority === 'urgent'
  // The agent state sits bottom right: on the meta row, or on the diff row when there is one.
  const status = agent ? (
    <AgentBadge agent={agent} />
  ) : task.agentSession ? (
    <span className="ml-auto text-faint" title="Has an agent chat to resume">
      ◈
    </span>
  ) : null

  return (
    <>
      <p className="line-clamp-3 pr-1 text-[13px] font-medium leading-[1.45] tracking-[-0.005em] text-ink">
        {queued ? (
          <span
            title={`Orchestrate will start this — position ${queued.position}, ${ORCHESTRATION_LANE_LABELS[queued.lane].toLowerCase()}`}
            className="mr-1.5 inline-flex size-[15px] items-center justify-center rounded-[5px] bg-accent align-[1px] font-mono text-[9.5px] font-semibold text-[var(--color-on-accent)]"
          >
            {queued.position}
          </span>
        ) : null}
        {task.title}
      </p>

      {task.project || task.tags.length > 0 || task.readiness === 'needs_spec' || loud ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1">
          {loud ? (
            <Chip tone="warn" title={`${task.priority} priority`}>
              {task.priority}
            </Chip>
          ) : null}
          {task.readiness === 'needs_spec' ? (
            <Chip tone="warn" title="Needs a spec before it can be worked on">
              needs spec
            </Chip>
          ) : null}
          {task.project ? <Chip tone="accent">{task.project}</Chip> : null}
          {task.tags.map((tag) => (
            <Chip key={tag}>{tag}</Chip>
          ))}
        </div>
      ) : null}

      <div className="mt-2.5 flex min-w-0 items-center gap-2 text-[10.5px] text-faint">
        <span className="shrink-0 whitespace-nowrap font-mono tracking-tight">{task.id}</span>
        {meta.length > 0 ? <span className="text-edge-strong">·</span> : null}
        {meta.map((item) => (
          <span key={item} className="shrink-0 whitespace-nowrap">
            {item}
          </span>
        ))}
        {task.prUrl ? (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            title={task.prUrl}
            className="shrink-0 whitespace-nowrap text-[var(--color-accent-text)] hover:underline"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            ⑂ PR
          </a>
        ) : null}
        {diffStat ? null : status}
      </div>

      {diffStat ? (
        <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[10.5px]">
          <button
            type="button"
            title={`${diffStat.files} ${diffStat.files === 1 ? 'file' : 'files'} changed · +${diffStat.added} −${diffStat.removed} — view changes`}
            aria-label={`View changes: ${diffStat.files} files, +${diffStat.added} −${diffStat.removed}`}
            className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[10.5px] text-faint transition-colors hover:bg-raised hover:text-ink"
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onShowChanges?.()
            }}
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
              strokeLinejoin="round"
            >
              <path d="M4 2.5h5l3 3v8H4z" />
              <path d="M6.25 7h3.5M8 5.25v3.5M6.25 11h3.5" />
            </svg>
            <DiffCount added={diffStat.added} removed={diffStat.removed} />
          </button>
          {status}
        </div>
      ) : null}
    </>
  )
}

function CardAction({
  label,
  title,
  onTrigger,
  accent = false
}: {
  label: string
  title: string
  onTrigger: () => void
  accent?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={`rounded-md border px-1.5 py-[3px] text-[10.5px] font-medium backdrop-blur-sm transition-colors ${
        accent
          ? 'border-accent/40 bg-accent/15 text-[var(--color-accent-text)] hover:bg-accent/25'
          : 'border-edge-strong bg-panel/90 text-dim hover:bg-raised hover:text-ink'
      }`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onTrigger()
      }}
    >
      {label}
    </button>
  )
}

export function TaskCard({
  task,
  agent,
  queued,
  onOpen,
  onLaunch,
  onArchive,
  onShowChanges,
  onOpenTerminal,
  diffStat,
  templateNameFor
}: {
  task: Task
  agent?: AgentStatus
  queued?: QueuedForOrchestration
  diffStat?: DiffStat
  onShowChanges: (task: Task) => void
  onOpenTerminal: (task: Task) => void
  onOpen: (task: Task) => void
  onLaunch: (task: Task) => void
  onArchive: (task: Task) => void
  templateNameFor: (task: Task) => string
}): ReactNode {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id
  })
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`group relative shrink-0 cursor-grab overflow-hidden rounded-[var(--radius-card)] border bg-card pl-3.5 pr-3 py-3 transition-[background-color,border-color,box-shadow] duration-150 hover:border-edge-strong hover:bg-raised hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.6)] active:cursor-grabbing ${
        isDragging ? 'opacity-40' : ''
      } ${queued ? 'border-accent/45' : 'border-edge'}`}
      onDoubleClick={() => onOpen(task)}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
      {...attributes}
      {...listeners}
    >
      <span
        role="img"
        aria-label={`${task.priority} priority`}
        title={`${task.priority} priority`}
        className="absolute inset-y-0 left-0 w-3"
      >
        <span className={`absolute inset-y-0 left-0 w-[3px] ${PRIORITY_BAR[task.priority]}`} />
      </span>
      <TaskCardBody
        task={task}
        agent={agent}
        queued={queued}
        diffStat={diffStat}
        onShowChanges={() => onShowChanges(task)}
      />
      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <CardAction label="Edit" title={`Edit ${task.id}`} onTrigger={() => onOpen(task)} />
        {task.status === 'done' ? (
          <CardAction
            label="Archive"
            title={`Archive ${task.id} — off the board, file kept`}
            onTrigger={() => onArchive(task)}
          />
        ) : null}
        {task.status !== 'done' ? (
          <CardAction
            accent
            label={task.agentSession ? '⏵ Resume' : '▶ Agent'}
            title={
              task.agentSession
                ? `Resume the existing agent chat for ${task.id}`
                : `Start the selected agent on ${task.id} — ${templateNameFor(task)}`
            }
            onTrigger={() => onLaunch(task)}
          />
        ) : null}
      </div>
      {menu ? (
        <CardMenu
          at={menu}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Edit task…', run: () => onOpen(task) },
            ...(task.status !== 'done'
              ? [
                  {
                    label: task.agentSession ? 'Resume agent' : 'Start agent',
                    run: () => onLaunch(task)
                  }
                ]
              : []),
            {
              label: 'View changes',
              counts: diffStat,
              disabled: !task.worktreePath,
              run: () => onShowChanges(task)
            },
            { label: 'Open terminal', run: () => onOpenTerminal(task) },
            'separator',
            {
              label: task.archivedAt ? 'Unarchive' : 'Archive',
              run: () => onArchive(task)
            }
          ]}
        />
      ) : null}
    </article>
  )
}

type MenuItem =
  'separator' | { label: string; run: () => void; counts?: DiffStat; disabled?: boolean }

/** A small context menu at the pointer. Closes on a click elsewhere, Escape, scroll or blur. */
function CardMenu({
  at,
  items,
  onClose
}: {
  at: { x: number; y: number }
  items: MenuItem[]
  onClose: () => void
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function onPointerDown(event: MouseEvent): void {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  // Keep the menu inside the window when opened near the right or bottom edge.
  const left = Math.min(at.x, window.innerWidth - 240)
  const top = Math.min(at.y, window.innerHeight - 220)
  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[60] flex w-[232px] flex-col gap-0.5 rounded-xl border border-edge-strong bg-chrome p-1.5 shadow-[0_16px_40px_-8px_rgba(0,0,0,0.7)]"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item === 'separator' ? (
          <div key={`sep-${index}`} className="my-1 border-t border-edge" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.run()
            }}
            className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[12px] text-dim hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40"
          >
            <span>{item.label}</span>
            {item.counts ? (
              <DiffCount added={item.counts.added} removed={item.counts.removed} />
            ) : null}
          </button>
        )
      )}
    </div>,
    document.body
  )
}
