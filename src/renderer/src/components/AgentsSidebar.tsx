import type { ReactNode } from 'react'
import { AGENT_STATE_LABELS, compareAgentStatus, type AgentStatus } from '@core/agentState.js'
import { AGENT_TONE } from '../lib/agentTone.js'
import type { Task, TerminalSessionInfo } from '@core/types.js'
import { Button } from './ui.js'

export interface AgentRow {
  task: Task
  agent?: AgentStatus
  session?: TerminalSessionInfo
}

export function sortAgentRows(rows: AgentRow[]): AgentRow[] {
  return [...rows].sort((a, b) => {
    if (a.agent && b.agent) return compareAgentStatus(a.agent, b.agent)
    return Number(Boolean(b.agent)) - Number(Boolean(a.agent))
  })
}

function timeAgo(iso?: string): string {
  if (!iso) return ''
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

function BranchGlyph(): ReactNode {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      className="shrink-0"
    >
      <circle cx="4.5" cy="3.5" r="1.8" />
      <circle cx="4.5" cy="12.5" r="1.8" />
      <circle cx="11.5" cy="3.5" r="1.8" />
      <path d="M4.5 5.3v5.4M11.5 5.3c0 3-2.8 3.4-5.2 4" />
    </svg>
  )
}

function AgentRowItem({
  row,
  onActivate,
  onOpenTask
}: {
  row: AgentRow
  onActivate: (row: AgentRow) => void
  onOpenTask: (task: Task) => void
}): ReactNode {
  const { task, agent, session } = row
  const state = agent?.state
  const label = state ? AGENT_STATE_LABELS[state] : 'No status yet'

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => onActivate(row)}
        title={session ? 'Focus this terminal tab' : 'Resume this agent chat'}
        className="flex w-full flex-col gap-1.5 rounded-lg border border-transparent px-2.5 py-2.5 text-left transition-colors hover:border-edge-strong hover:bg-raised"
      >
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={`size-[6px] shrink-0 rounded-full bg-current ${
              state === 'working' ? 'wd-pulse' : ''
            } ${state ? AGENT_TONE[state] : 'text-faint'}`}
          />
          <span className={`text-[11.5px] font-medium ${state ? AGENT_TONE[state] : 'text-faint'}`}>
            {label}
          </span>
          {session ? (
            <span className="rounded bg-raised px-1 text-[10px] text-faint">live</span>
          ) : null}
          <span className="ml-auto font-mono text-[10px] text-faint">{timeAgo(agent?.at)}</span>
        </span>

        <span className="line-clamp-2 text-[12.5px] leading-snug text-ink">{task.title}</span>

        {agent?.lastMessage ? (
          <span className="line-clamp-2 text-[11px] leading-snug text-faint">
            {agent.lastMessage}
          </span>
        ) : null}

        <span className="font-mono text-[10px] text-faint">{task.id}</span>

        {agent?.branch ? (
          <span
            className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-faint"
            title={`On branch ${agent.branch}`}
          >
            <BranchGlyph />
            <span className="truncate">{agent.branch}</span>
          </span>
        ) : null}
      </button>

      <button
        type="button"
        aria-label={`Open ${task.id}`}
        title={`Open ${task.id}`}
        className="absolute right-2 top-2 rounded border border-edge-strong bg-panel px-1.5 py-[2px] text-[10px] text-dim opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
        onClick={() => onOpenTask(task)}
      >
        Open
      </button>
    </li>
  )
}

export function AgentsSidebar({
  rows,
  onActivate,
  onOpenTask,
  onClose
}: {
  rows: AgentRow[]
  onActivate: (row: AgentRow) => void
  onOpenTask: (task: Task) => void
  onClose: () => void
}): ReactNode {
  const waiting = rows.filter((row) => row.agent?.state === 'waiting').length

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-edge bg-chrome">
      <header className="flex items-center gap-2 border-b border-edge px-3 py-3">
        <h2 className="text-[12.5px] font-semibold tracking-[-0.005em]">Agents</h2>
        <span className="rounded-md bg-raised px-1.5 py-[1px] font-mono text-[10.5px] text-dim">
          {rows.length}
        </span>
        {waiting > 0 ? (
          <span className="rounded-md bg-[var(--color-col-review)]/15 px-1.5 py-[1px] text-[10.5px] font-medium text-[var(--color-col-review)]">
            {waiting} waiting
          </span>
        ) : null}
        <Button
          variant="subtle"
          className="ml-auto px-2"
          onClick={onClose}
          aria-label="Hide agents"
        >
          ✕
        </Button>
      </header>

      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
          <p className="text-[12.5px] text-dim">No agents yet</p>
          <p className="text-[11.5px] leading-relaxed text-faint">
            Start an agent on a task and it shows up here with its live status.
          </p>
        </div>
      ) : (
        <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
          {rows.map((row) => (
            <AgentRowItem
              key={row.task.id}
              row={row}
              onActivate={onActivate}
              onOpenTask={onOpenTask}
            />
          ))}
        </ul>
      )}
    </aside>
  )
}
