import { useEffect, useState, type ReactNode } from 'react'
import {
  AGENT_STATE_LABELS,
  runningSubagents,
  subagentCountLabel,
  type AgentStatus
} from '@core/agentState.js'
import { TASK_STATUS_LABELS, type ActivityEntry, type Task } from '@core/types.js'
import { STATUS_DOT } from '../lib/statusTone.js'

/**
 * The floating panel's width, and the room the terminal leaves for it. The terminal is narrowed by
 * the same amount, so nothing it prints sits under the panel; on a narrow panel it takes less.
 */
export const ACTIVITY_WIDTH = 'min(300px, 45%)'
export const ACTIVITY_RESERVE = `calc(${ACTIVITY_WIDTH} + 8px)`

/** `now`, `4m`, a time today, or a date: short enough for the panel's meta line. */
export function activityTime(iso: string, now = new Date()): string {
  const at = new Date(iso)
  const seconds = (now.getTime() - at.getTime()) / 1000
  if (!Number.isFinite(seconds)) return ''
  if (seconds >= 0 && seconds < 60) return 'now'
  if (seconds >= 0 && seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (at.toDateString() === now.toDateString())
    return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * How many entries each task had when its activity was last in view, so a closed panel can count
 * what arrived since. A task seen for the first time counts as read: only new entries are news.
 */
export function useActivityUnread(task: Task | undefined, open: boolean): number {
  const [seen, setSeen] = useState<ReadonlyMap<string, number>>(new Map())
  const id = task?.id
  const count = task?.activity.length ?? 0
  const known = id === undefined ? undefined : seen.get(id)
  useEffect(() => {
    if (id === undefined || (known !== undefined && (!open || known === count))) return
    setSeen((current) => new Map(current).set(id, count))
  }, [id, count, open, known])
  return open || known === undefined ? 0 : Math.max(0, count - known)
}

function ActivityIcon(): ReactNode {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className="shrink-0"
    >
      <circle cx="4" cy="4" r="1.4" />
      <circle cx="4" cy="12" r="1.4" />
      <path d="M4 5.6v4.8M7.5 4h5M7.5 12h5" />
    </svg>
  )
}

/** Shows or hides the panel: in the terminal's bar, or in the tab bar while a full-screen app runs. */
export function ActivityToggle({
  open,
  unread,
  hint,
  inHeader = false,
  onToggle
}: {
  open: boolean
  unread: number
  hint: string
  /** The tab bar's taller, outlined variant. */
  inHeader?: boolean
  onToggle: () => void
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={open}
      title={`${open ? 'Hide' : 'Show'} task activity${hint ? ` (${hint})` : ''}`}
      className={`pointer-events-auto inline-flex items-center gap-1.5 rounded-md border font-medium hover:bg-raised/70 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent ${
        inHeader ? 'h-6 px-2 text-[12.5px]' : 'h-[22px] px-[7px] text-[11.5px]'
      } ${open ? `bg-raised text-ink ${inHeader ? 'border-edge-strong' : 'border-transparent'}` : 'border-transparent text-dim'}`}
      onClick={onToggle}
    >
      <ActivityIcon />
      <span className={inHeader ? undefined : 'hidden @md:inline'}>Activity</span>
      {unread ? (
        <span className="min-w-3.5 rounded-full bg-raised px-1 font-mono text-[10px] leading-[14px] text-col-progress">
          {unread}
        </span>
      ) : null}
    </button>
  )
}

function dotTone(entry: ActivityEntry): string {
  if (entry.author === 'you' || !entry.author) return 'bg-dim'
  return entry.author === 'subagent' ? 'bg-col-done' : 'bg-col-progress'
}

/**
 * The task's activity, floating over the right of its terminal: the same log as the task dialog's
 * Activity tab, newest first, so an agent's progress reads without leaving the terminal.
 */
export function TerminalActivity({
  task,
  agent,
  hint,
  onOpenTask,
  onClose
}: {
  task: Task
  /** The task's agent, as the views label it. */
  agent?: AgentStatus
  hint: string
  onOpenTask: () => void
  onClose: () => void
}): ReactNode {
  const entries = [...task.activity].reverse()
  const working = agent?.state === 'working'
  const subagents = runningSubagents(agent)
  return (
    <aside
      aria-label="Task activity"
      style={{ width: ACTIVITY_WIDTH }}
      className="absolute bottom-2 right-0 top-0 z-10 flex flex-col overflow-hidden rounded-[10px] border border-edge-strong bg-panel shadow-2xl"
    >
      <header className="flex h-[34px] shrink-0 items-center gap-2 border-b border-edge pl-3 pr-1">
        <span className="text-[12px] font-semibold text-ink">Activity</span>
        <span className="font-mono text-[10.5px] text-faint">{task.id}</span>
        <span className="flex-1" />
        <button
          type="button"
          title={`Open ${task.id} in the task dialog`}
          className="inline-flex h-[22px] items-center rounded-md px-[7px] text-[11.5px] font-medium text-dim hover:bg-raised/70 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          onClick={onOpenTask}
        >
          Open task
        </button>
        <button
          type="button"
          title={`Hide activity${hint ? ` (${hint})` : ''}`}
          aria-label="Hide activity"
          className="inline-flex size-6 items-center justify-center rounded-md text-[10px] text-dim hover:bg-raised/70 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-edge px-3 py-2.5">
        <span
          title={task.title}
          className="line-clamp-2 text-[12.5px] font-medium leading-snug text-ink"
        >
          {task.title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-dim">
          <span className="inline-flex h-[18px] shrink-0 items-center gap-[5px] rounded-md bg-raised px-1.5 text-[10.5px] font-medium text-ink">
            <span
              aria-hidden
              className={`size-1.5 rounded-full ${STATUS_DOT[task.status]} ${working ? 'wd-pulse' : ''}`}
            />
            {TASK_STATUS_LABELS[task.status]}
          </span>
          {agent ? (
            <span className="truncate">
              {AGENT_STATE_LABELS[agent.state]}
              {subagents ? ` · ${subagentCountLabel(subagents)}` : ''}
            </span>
          ) : null}
        </span>
      </div>
      <ol className="m-0 flex min-h-0 flex-1 list-none flex-col overflow-y-auto px-3 pb-1 pt-3">
        {entries.length === 0 ? <li className="text-[12px] text-faint">No activity yet.</li> : null}
        {entries.map((entry, index) => {
          // The newest entry is the one the agent is working from while it works.
          const live = working && index === 0
          return (
            <li
              key={`${entries.length - index}-${entry.at}`}
              className="grid grid-cols-[12px_minmax(0,1fr)] gap-x-2.5"
            >
              <span className="flex flex-col items-center">
                <span
                  className={`mt-1 size-[7px] shrink-0 rounded-full ${dotTone(entry)} ${live ? 'wd-pulse' : ''}`}
                />
                {index < entries.length - 1 ? <span className="w-px flex-1 bg-edge" /> : null}
              </span>
              <div className="flex min-w-0 flex-col gap-0.5 pb-3.5">
                {entry.at || entry.author ? (
                  <span
                    title={entry.at ? new Date(entry.at).toLocaleString() : undefined}
                    className={`font-mono text-[10.5px] ${live ? 'text-col-progress' : 'text-faint'}`}
                  >
                    {[entry.at ? activityTime(entry.at) : '', entry.author]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                ) : null}
                <p className="m-0 whitespace-pre-wrap text-[12px] leading-normal text-ink">
                  {entry.message}
                </p>
              </div>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
