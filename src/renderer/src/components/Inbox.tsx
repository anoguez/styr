import { useMemo, useState, type ReactNode } from 'react'
import { AGENT_STATE_LABELS } from '@core/agentState.js'
import type { AgentStatus } from '@core/agentState.js'
import type { DiffStat } from '@core/diff.js'
import {
  buildInbox,
  INBOX_GROUPS,
  INBOX_GROUP_LABELS,
  type InboxGroup,
  type InboxItem
} from '@core/inbox.js'
import type { Task, TaskPriority, TaskStatus } from '@core/types.js'
import { AGENT_TONE } from '../lib/agentTone.js'
import { timeAgo } from '../lib/timeAgo.js'
import { Button, Chip, DiffStatButton } from './ui.js'

const GROUP_DOT: Record<InboxGroup, string> = {
  needs: 'bg-[var(--color-col-review)]',
  running: 'bg-[var(--color-col-progress)]',
  next: 'bg-dim',
  done: 'bg-[var(--color-col-done)]'
}

const PRIORITY_BAR: Record<TaskPriority, string> = {
  low: 'bg-[var(--color-pri-low)]',
  medium: 'bg-[var(--color-pri-medium)]',
  high: 'bg-[var(--color-pri-high)]',
  urgent: 'bg-[var(--color-pri-urgent)]'
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done'
}

const STATUS_DOT: Record<TaskStatus, string> = {
  backlog: 'bg-[var(--color-col-backlog)]',
  in_progress: 'bg-[var(--color-col-progress)]',
  in_review: 'bg-[var(--color-col-review)]',
  done: 'bg-[var(--color-col-done)]'
}

function itemDot(item: InboxItem): string {
  if (item.agent) return AGENT_TONE[item.agent.state]
  if (item.kind === 'spec') return 'text-[var(--color-col-review-text)]'
  if (item.kind === 'done') return 'text-[var(--color-col-done)]'
  return 'text-edge-strong'
}

function itemStatus(item: InboxItem): string {
  if (item.agent) return AGENT_STATE_LABELS[item.agent.state]
  if (item.kind === 'spec') return 'Needs a spec'
  if (item.kind === 'done') return 'Done'
  return 'Idle'
}

export interface InboxHandlers {
  onOpen: (task: Task) => void
  onLaunch: (task: Task) => void
  /** Focus the task's terminal tab, or resume its chat when there is none. */
  onActivate: (task: Task) => void
  onShowChanges: (task: Task) => void
  onMove: (task: Task, status: TaskStatus) => void
  onArchive: (task: Task) => void
}

interface InboxAction {
  label: string
  run: () => void
}

/** What the inbox offers for a task, by why it is there. Every action is one the board also has. */
function actionsFor(
  item: InboxItem,
  hasDiff: boolean,
  h: InboxHandlers
): { primary: InboxAction; secondary: InboxAction[] } {
  const { task } = item
  const open: InboxAction = { label: 'Open task', run: () => h.onOpen(task) }
  const terminal: InboxAction = { label: 'Open terminal', run: () => h.onActivate(task) }
  const done: InboxAction = { label: 'Move to Done', run: () => h.onMove(task, 'done') }
  switch (item.kind) {
    case 'waiting':
    case 'running':
      return { primary: terminal, secondary: [open] }
    case 'review':
      return {
        primary: hasDiff ? { label: 'Review changes', run: () => h.onShowChanges(task) } : open,
        secondary: [done, terminal, ...(hasDiff ? [open] : [])]
      }
    case 'spec':
      return {
        primary: { label: 'Write spec', run: () => h.onOpen(task) },
        secondary: [{ label: 'Start Claude', run: () => h.onLaunch(task) }]
      }
    case 'resumable':
      return {
        primary: { label: 'Resume session', run: () => h.onActivate(task) },
        secondary: [open, ...(task.status === 'in_review' ? [done] : [])]
      }
    case 'done':
      return {
        primary: { label: 'Reopen', run: () => h.onMove(task, 'backlog') },
        secondary: [{ label: 'Archive', run: () => h.onArchive(task) }]
      }
    case 'finished':
      return { primary: terminal, secondary: [open] }
    case 'queued':
    case 'idle':
      return {
        primary: { label: 'Start Claude', run: () => h.onLaunch(task) },
        secondary: [{ label: 'Edit task', run: () => h.onOpen(task) }]
      }
  }
}

function StatCard({
  group,
  count,
  hint,
  active,
  onClick
}: {
  group: InboxGroup
  count: number
  hint: string
  active: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex min-w-0 flex-col gap-1 rounded-[10px] border px-3 py-2.5 text-left transition-colors hover:border-edge-strong hover:bg-raised ${
        active ? 'border-edge-strong bg-raised' : 'border-edge bg-panel/80'
      }`}
    >
      <span className="flex items-center gap-[7px] text-[12px] font-medium text-dim">
        <span
          aria-hidden
          className={`size-[7px] rounded-full ${GROUP_DOT[group]} ${group === 'running' && count > 0 ? 'wd-pulse' : ''}`}
        />
        {INBOX_GROUP_LABELS[group]}
      </span>
      <span
        className={`font-mono text-[22px] font-semibold leading-none ${
          group === 'needs' && count > 0 ? 'text-[var(--color-col-review-text)]' : 'text-ink'
        }`}
      >
        {count}
      </span>
      <span className="truncate text-[11.5px] text-faint">{hint}</span>
    </button>
  )
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function hintFor(group: InboxGroup, items: InboxItem[]): string {
  const count = (kind: InboxItem['kind']): number => items.filter((i) => i.kind === kind).length
  switch (group) {
    case 'needs':
      return (
        [
          count('waiting') > 0 ? plural(count('waiting'), 'permission') : '',
          count('review') > 0 ? plural(count('review'), 'review') : '',
          count('spec') > 0 ? plural(count('spec'), 'spec') : ''
        ]
          .filter(Boolean)
          .join(' · ') || 'Nothing waiting on you'
      )
    case 'running':
      return items.length > 0 ? 'Agents at work' : 'No agent is working'
    case 'next':
      return count('queued') > 0 ? `${count('queued')} queued for Orchestrate` : 'Not started yet'
    case 'done':
      return 'Shown on the board'
  }
}

function Row({
  item,
  selected,
  onSelect
}: {
  item: InboxItem
  selected: boolean
  onSelect: () => void
}): ReactNode {
  const { task, agent } = item
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      className={`flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-[9px] text-left transition-colors hover:bg-raised ${
        selected ? 'border-edge-strong bg-raised' : 'border-transparent'
      } ${item.kind === 'done' ? 'opacity-60' : ''}`}
    >
      <span
        aria-hidden
        className={`mt-[6px] size-[6px] shrink-0 rounded-full bg-current ${itemDot(item)} ${
          agent?.state === 'working' ? 'wd-pulse' : ''
        }`}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex items-baseline gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-[13px] leading-[1.4] text-ink ${
              item.group === 'needs' ? 'font-semibold' : 'font-medium'
            }`}
          >
            {task.title}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-faint">{timeAgo(item.at)}</span>
        </span>
        <span
          className={`truncate text-[11.5px] leading-[1.4] ${
            item.kind === 'waiting' ? 'text-[var(--color-col-review-text)]' : 'text-dim'
          }`}
        >
          {item.reason}
        </span>
        <span className="flex items-center gap-2 font-mono text-[10.5px] text-faint">
          <span>{task.id}</span>
          <span className="inline-flex items-center gap-1 font-sans">
            <span aria-hidden className={`size-[5px] rounded-full ${STATUS_DOT[task.status]}`} />
            {STATUS_LABELS[task.status]}
          </span>
        </span>
      </span>
    </button>
  )
}

function Detail({
  item,
  diffStat,
  handlers
}: {
  item: InboxItem
  diffStat?: DiffStat
  handlers: InboxHandlers
}): ReactNode {
  const { task, agent } = item
  const { primary, secondary } = actionsFor(item, diffStat !== undefined, handlers)
  const facts: { key: string; value: string; mono?: boolean }[] = [
    { key: 'Column', value: STATUS_LABELS[task.status] },
    { key: 'Priority', value: task.priority[0]!.toUpperCase() + task.priority.slice(1) },
    ...(agent?.branch ? [{ key: 'Branch', value: agent.branch, mono: true }] : []),
    ...(task.contextFiles.length > 0
      ? [{ key: 'Files', value: `${task.contextFiles.length} attached` }]
      : []),
    ...(task.activity.length > 0 ? [{ key: 'Notes', value: String(task.activity.length) }] : [])
  ]
  const chips = [
    ...(task.readiness === 'needs_spec' ? [{ label: 'needs spec', tone: 'warn' as const }] : []),
    ...(task.project ? [{ label: task.project, tone: 'accent' as const }] : []),
    ...task.tags.map((label) => ({ label, tone: 'neutral' as const }))
  ]
  return (
    <div className="flex max-w-[720px] min-w-0 flex-col gap-[18px] px-[26px] py-[22px]">
      <div className="flex flex-col gap-2.5">
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[11.5px] text-dim">
          <span className="font-mono text-[10.5px] text-faint">{task.id}</span>
          <span className="inline-flex items-center gap-[5px]">
            <span aria-hidden className={`size-[6px] rounded-full ${STATUS_DOT[task.status]}`} />
            {STATUS_LABELS[task.status]}
          </span>
          <span className="inline-flex items-center gap-[5px]">
            <span aria-hidden className={`h-3 w-[3px] rounded-sm ${PRIORITY_BAR[task.priority]}`} />
            {task.priority}
          </span>
        </span>
        <h1 className="m-0 text-[19px] font-semibold leading-[1.35] tracking-[-0.01em] text-ink [text-wrap:pretty]">
          {task.title}
        </h1>
        {chips.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {chips.map((chip) => (
              <Chip key={chip.label} tone={chip.tone}>
                {chip.label}
              </Chip>
            ))}
          </div>
        ) : null}
      </div>

      <div
        className={`flex flex-col gap-3 rounded-[10px] border bg-card p-3.5 ${
          item.kind === 'waiting' ? 'border-[var(--color-col-review)]/35' : 'border-edge'
        }`}
      >
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={`size-[6px] rounded-full bg-current ${itemDot(item)} ${
              agent?.state === 'working' ? 'wd-pulse' : ''
            }`}
          />
          <span className={`text-[11.5px] font-medium ${itemDot(item)}`}>{itemStatus(item)}</span>
          <span className="ml-auto font-mono text-[10.5px] text-faint">{timeAgo(item.at)}</span>
        </span>
        <p className="m-0 text-[13px] leading-[1.5] text-ink">{item.reason}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="primary" onClick={primary.run}>
            {primary.label}
          </Button>
          {secondary.map((action) => (
            <Button key={action.label} onClick={action.run}>
              {action.label}
            </Button>
          ))}
          {diffStat && primary.label !== 'Review changes' ? (
            <DiffStatButton stat={diffStat} onClick={() => handlers.onShowChanges(task)} />
          ) : null}
        </div>
      </div>

      <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-y-2.5 text-[12.5px]">
        {facts.map((fact) => (
          <div key={fact.key} className="contents">
            <dt className="text-faint">{fact.key}</dt>
            <dd className={`m-0 text-ink ${fact.mono ? 'font-mono text-[12px]' : ''}`}>
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * The board regrouped by what wants attention. It reads the same tasks and agent states as the
 * board (`buildInbox`) and writes only through the board's own actions.
 */
export function Inbox({
  tasks,
  agents,
  queued,
  diffStats,
  ...handlers
}: {
  tasks: Task[]
  agents: Map<string, AgentStatus>
  /** Orchestrate queue positions, 1-based, by task id. */
  queued: Map<string, number>
  diffStats: Map<string, DiffStat>
} & InboxHandlers): ReactNode {
  const groups = useMemo(() => buildInbox(tasks, agents, queued), [tasks, agents, queued])
  const [filter, setFilter] = useState<InboxGroup | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const visible = INBOX_GROUPS.filter((group) => !filter || group === filter)
  const flat = visible.flatMap((group) => groups[group])
  // A selection that left the list (finished, filtered out, searched away) falls to the first row.
  const selected = flat.find((item) => item.task.id === selectedId) ?? flat[0]
  const today = new Date().toDateString()
  // There is no status history, so "moved" is any task written today.
  const movedToday = tasks.filter(
    (task) => new Date(task.updatedAt).toDateString() === today
  ).length
  const prsReady = tasks.filter((task) => task.prUrl && task.status !== 'done').length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.4fr)] gap-2 px-4 pt-3.5">
        {INBOX_GROUPS.map((group) => (
          <StatCard
            key={group}
            group={group}
            count={groups[group].length}
            hint={hintFor(group, groups[group])}
            active={filter === group}
            onClick={() => setFilter((current) => (current === group ? null : group))}
          />
        ))}
        <div className="flex min-w-0 flex-col gap-1 rounded-[10px] border border-edge bg-chrome px-3 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-faint">
            Today
          </span>
          <div className="flex flex-col gap-0.5">
            {[
              { v: movedToday, k: 'tasks moved' },
              { v: prsReady, k: 'PRs ready' }
            ].map((row) => (
              <span
                key={row.k}
                className="flex items-baseline justify-between gap-2.5 text-[11.5px] leading-[1.35] text-dim"
              >
                {row.k}
                <span className="font-mono text-[12px] font-semibold text-ink">{row.v}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(240px,2fr)_minmax(0,3fr)] gap-3.5 p-4">
        <section className="flex min-h-0 flex-col overflow-y-auto rounded-xl border border-edge bg-panel/80 p-1.5">
          {flat.length === 0 ? <p className="p-4 text-[12.5px] text-faint">Nothing here.</p> : null}
          {visible.map((group) =>
            groups[group].length === 0 ? null : (
              <div key={group} className="flex flex-col gap-0.5 pb-1.5">
                <header className="flex h-7 items-center gap-2 px-2">
                  <span aria-hidden className={`size-[7px] rounded-full ${GROUP_DOT[group]}`} />
                  <h2 className="m-0 text-[12px] font-semibold text-ink">
                    {INBOX_GROUP_LABELS[group]}
                  </h2>
                  <span className="rounded-md bg-raised px-1.5 font-mono text-[10.5px] leading-[18px] text-dim">
                    {groups[group].length}
                  </span>
                </header>
                {groups[group].map((item) => (
                  <Row
                    key={item.task.id}
                    item={item}
                    selected={item.task.id === selected?.task.id}
                    onSelect={() => setSelectedId(item.task.id)}
                  />
                ))}
              </div>
            )
          )}
        </section>
        <section className="flex min-h-0 min-w-0 flex-col overflow-y-auto rounded-xl border border-edge bg-panel/80">
          {selected ? (
            <Detail
              item={selected}
              diffStat={diffStats.get(selected.task.id)}
              handlers={handlers}
            />
          ) : null}
        </section>
      </div>
    </div>
  )
}
