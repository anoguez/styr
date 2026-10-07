import { useContext, useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AGENT_STATE_LABELS, type AgentStatus } from '@core/agentState.js'
import { AGENT_TONE } from '../lib/agentTone.js'
import {
  ORCHESTRATION_LANE_LABELS,
  TASK_STATUS_LABELS,
  type OrchestrationLane,
  type Task,
  type TaskPriority
} from '@core/types.js'
import type { DiffStat } from '@core/diff.js'
import { DispatchingContext } from '../lib/dispatchRun.js'
import { describeBlockers, useOpenBlockers } from '../lib/blockerContext.js'
import { Chip, DiffCount, DiffStatButton } from './ui.js'

const PRIORITY_BAR: Record<TaskPriority, string> = {
  low: 'bg-[var(--color-pri-low)]',
  medium: 'bg-[var(--color-pri-medium)]',
  high: 'bg-[var(--color-pri-high)]',
  urgent: 'bg-[var(--color-pri-urgent)]'
}

const ICON_PATHS: Record<'file' | 'note' | 'pr' | 'issue', ReactNode> = {
  file: (
    <g strokeLinejoin="round">
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.5v3h3" />
    </g>
  ),
  note: <path d="M3 13.5h3l7-7-3-3-7 7z" strokeLinecap="round" strokeLinejoin="round" />,
  pr: (
    <g strokeLinecap="round">
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="12.5" r="1.6" />
      <path d="M4.5 5.1v5.8M11.5 10.9V6.5a2 2 0 0 0-2-2H7.5" />
    </g>
  ),
  issue: (
    <g>
      <circle cx="8" cy="8" r="5.25" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
    </g>
  )
}

/** One stroke style for every glyph in the refs row, so the row reads as a single set. */
function RefIcon({ name }: { name: keyof typeof ICON_PATHS }): ReactNode {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      {ICON_PATHS[name]}
    </svg>
  )
}

function Dot({ pulse = false }: { pulse?: boolean }): ReactNode {
  return (
    <span
      aria-hidden
      className={`size-[6px] shrink-0 rounded-full bg-current ${pulse ? 'wd-pulse' : ''}`}
    />
  )
}

export function AgentBadge({ agent }: { agent: AgentStatus }): ReactNode {
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-[5px] whitespace-nowrap font-medium ${AGENT_TONE[agent.state]}`}
      title={
        agent.lastMessage ? `${AGENT_STATE_LABELS[agent.state]} — ${agent.lastMessage}` : undefined
      }
    >
      <Dot pulse={agent.state === 'working'} />
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
  const blockers = useOpenBlockers(task)
  const dispatching = useContext(DispatchingContext).has(task.id)
  const loud = task.priority === 'high' || task.priority === 'urgent'
  const files = task.contextFiles.length
  const notes = task.activity.length
  const stop = { onPointerDown: (e: SyntheticEvent) => e.stopPropagation() }
  const linkClass =
    'inline-flex shrink-0 items-center gap-[3px] whitespace-nowrap text-[var(--color-accent-text)] hover:underline'
  const prLink = task.prUrl ? (
    <a
      href={task.prUrl}
      target="_blank"
      rel="noreferrer"
      title={task.prUrl}
      className={linkClass}
      {...stop}
      onClick={(event) => event.stopPropagation()}
    >
      <RefIcon name="pr" />
      PR
    </a>
  ) : null
  const issueLink = task.externalRef?.url ? (
    <a
      href={task.externalRef.url}
      target="_blank"
      rel="noreferrer"
      title={task.externalRef.url}
      className={`${linkClass} font-mono`}
      {...stop}
      onClick={(event) => event.stopPropagation()}
    >
      <RefIcon name="issue" />
      {task.externalRef.id}
    </a>
  ) : null
  // "Needs spec" and "Chat to resume" are states too, so they share the strip with the agent.
  const state = agent ? (
    <AgentBadge agent={agent} />
  ) : task.readiness === 'needs_spec' ? (
    <span
      className="inline-flex min-w-0 items-center gap-[5px] whitespace-nowrap font-medium text-[var(--color-col-review-text)]"
      title="Needs a spec before it can be worked on"
    >
      <Dot />
      <span className="truncate">Needs spec</span>
    </span>
  ) : task.agentSession ? (
    <span
      className="inline-flex min-w-0 items-center gap-[5px] whitespace-nowrap font-medium text-dim"
      title="Has an agent chat to resume"
    >
      <Dot />
      <span className="truncate">Chat to resume</span>
    </span>
  ) : null

  return (
    <>
      <p className="line-clamp-3 pr-1 text-[13px] font-medium leading-[1.45] tracking-[-0.005em] text-ink">
        {queued ? (
          <span
            title={`Dispatch will start this — position ${queued.position}, ${ORCHESTRATION_LANE_LABELS[queued.lane].toLowerCase()}`}
            className="mr-1.5 inline-flex size-[15px] items-center justify-center rounded-[5px] bg-accent align-[1px] font-mono text-[9.5px] font-semibold text-[var(--color-on-accent)]"
          >
            {queued.position}
          </span>
        ) : null}
        {task.title}
      </p>

      {loud || task.project || task.tags.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1">
          {loud ? (
            <span
              title={`${task.priority} priority`}
              className="inline-flex items-center rounded-md px-1.5 py-[1px] text-[10.5px] font-semibold capitalize"
              style={{
                color: `var(--color-pri-${task.priority})`,
                background: `color-mix(in oklab, var(--color-pri-${task.priority}) 15%, transparent)`
              }}
            >
              {task.priority}
            </span>
          ) : null}
          {task.project ? <Chip tone="accent">{task.project}</Chip> : null}
          {task.tags.map((tag) => (
            <Chip key={tag}>{tag}</Chip>
          ))}
        </div>
      ) : null}

      <div className="mt-2.5 flex min-w-0 items-center gap-2.5 text-[10.5px] text-faint">
        <span className="shrink-0 whitespace-nowrap font-mono tracking-tight">{task.id}</span>
        {dispatching ? (
          <span
            title="Picked up by Dispatch"
            className="inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-accent/20 px-1.5 font-medium text-[var(--color-accent-text)]"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M13.5 2.5 2.5 7l4.5 2 2 4.5z" />
              <path d="M13.5 2.5 7 9" />
            </svg>
            Dispatching
          </span>
        ) : null}
        {blockers.length > 0 ? (
          <span
            className="shrink-0 whitespace-nowrap font-medium text-[var(--color-col-review-text)]"
            title={`Waiting on ${describeBlockers(blockers, (blocker) => TASK_STATUS_LABELS[blocker.status])}`}
          >
            Blocked · {blockers.length === 1 ? blockers[0]?.id : blockers.length}
          </span>
        ) : null}
        {issueLink}
        {prLink}
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono">
          {files > 0 ? (
            <span className="inline-flex items-center gap-[3px]" title={`${files} context files`}>
              <RefIcon name="file" />
              {files}
            </span>
          ) : null}
          {notes > 0 ? (
            <span className="inline-flex items-center gap-[3px]" title={`${notes} notes`}>
              <RefIcon name="note" />
              {notes}
            </span>
          ) : null}
        </span>
      </div>

      {state || diffStat ? (
        <div className="-ml-3.5 -mr-3 mt-[9px] flex min-w-0 items-center gap-2 border-t border-edge pl-3.5 pr-3 pt-[7px] text-[11px]">
          {state}
          {diffStat ? (
            <span className="-mr-1 ml-auto shrink-0">
              <DiffStatButton stat={diffStat} onClick={() => onShowChanges?.()} />
            </span>
          ) : null}
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
      className={`group relative shrink-0 cursor-grab overflow-hidden rounded-[var(--radius-card)] border bg-card pl-3.5 pr-3 pb-2.5 pt-3 transition-[background-color,border-color,box-shadow] duration-150 hover:border-edge-strong hover:bg-raised hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.6)] active:cursor-grabbing ${
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
