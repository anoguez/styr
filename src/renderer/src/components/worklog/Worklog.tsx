import { useMemo, useState, type ReactNode } from 'react'
import type { Task, WorklogPeriod } from '@core/types.js'
import {
  buildWorklog,
  dayLabel,
  formatTable,
  formatTokens,
  worklogFrame,
  worklogTable,
  type Worklog as WorklogModel
} from '@core/worklog.js'
import { useWorklog } from '../../hooks/useWorklog.js'
import { Button } from '../ui.js'
import { ProjectBreakdown, WorklogChart } from './WorklogChart.js'
import { WorklogTable } from './WorklogTable.js'

/** Fixed hues for projects, from the theme, in the order projects are first seen. */
const PROJECT_TONES = [
  'var(--color-accent-soft)',
  'var(--color-col-progress)',
  'var(--color-col-done)',
  'var(--color-pri-high)',
  'var(--color-pri-urgent)',
  'var(--color-col-backlog)'
]

const PERIODS: { id: WorklogPeriod; label: string; now: string }[] = [
  { id: 'day', label: 'Day', now: 'Today' },
  { id: 'week', label: 'Week', now: 'This week' },
  { id: 'month', label: 'Month', now: 'This month' }
]

const tabClass = (on: boolean): string =>
  `inline-flex h-[22px] items-center rounded-md border px-2.5 text-[12px] font-medium transition-colors ${
    on ? 'border-edge-strong bg-raised text-ink' : 'border-transparent text-dim hover:text-ink'
  }`

const iconButton =
  'inline-flex size-7 items-center justify-center rounded-lg border border-edge-strong bg-raised/70 text-dim hover:bg-raised hover:text-ink disabled:opacity-40 disabled:hover:bg-raised/70'

function Chevron({ back }: { back?: boolean }): ReactNode {
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
      strokeLinejoin="round"
    >
      <path d={back ? 'M10 3.5 5.5 8l4.5 4.5' : 'M6 3.5 10.5 8 6 12.5'} />
    </svg>
  )
}

interface SummaryCard {
  label: string
  tone: string
  value: string
  unit: string
  hint: string
}

function summaryCards(worklog: WorklogModel): SummaryCard[] {
  const tasks = worklog.rows.length
  const share = (tokens: number): string =>
    `${worklog.tokens ? Math.round((tokens / worklog.tokens) * 100) : 0}%`
  return [
    {
      label: 'Tokens',
      tone: 'var(--color-accent-soft)',
      value: formatTokens(worklog.tokens),
      unit: 'tokens',
      hint: 'Input and output; cache reads not counted'
    },
    {
      label: 'Sessions',
      tone: 'var(--color-col-progress)',
      value: String(worklog.sessions),
      unit: worklog.sessions === 1 ? 'session' : 'sessions',
      hint: worklog.sessions
        ? `${formatTokens(worklog.tokens / worklog.sessions)} tokens per session`
        : 'No agent sessions in this period'
    },
    {
      label: 'Busiest day',
      tone: 'var(--color-col-done)',
      value: worklog.busiest ? formatTokens(worklog.busiest.tokens) : '—',
      unit: worklog.busiest ? 'tokens' : '',
      hint: worklog.busiest ? dayLabel(worklog.busiest.day) : 'No tokens used yet'
    },
    {
      label: 'Tasks worked',
      tone: 'var(--color-col-backlog)',
      value: String(tasks),
      unit: tasks === 1 ? 'task' : 'tasks',
      hint: worklog.groups.map((group) => `${group.project} ${share(group.tokens)}`).join(' · ')
    }
  ]
}

/**
 * The Worklog: the agent work each task took, per day — tokens used and sessions run — read from the
 * tasks' transcripts. Every number is derived on the fly (`core/worklog.ts`).
 */
export function Worklog({
  tasks
}: {
  /** Every task on the board, archived included. A new array whenever they change, which refetches. */
  tasks: readonly Task[]
}): ReactNode {
  const [period, setPeriod] = useState<WorklogPeriod>('week')
  const [offset, setOffset] = useState(0)
  const [groupBy, setGroupBy] = useState<'task' | 'project'>('task')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [copied, setCopied] = useState(false)

  const now = Date.now()
  const frame = worklogFrame(period, offset, now)
  const data = useWorklog(frame.from, frame.to, tasks)
  const worklog = useMemo(
    () => (data ? buildWorklog(frame, data.tasks, now) : null),
    // `frame` and `now` are rebuilt every render; the span says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, period, offset]
  )

  // Colours follow the project names, sorted, so a project keeps its colour across periods.
  const projects = useMemo(
    () => [...new Set(worklog?.groups.map((group) => group.project) ?? [])].sort(),
    [worklog]
  )
  const colorOf = (project: string): string =>
    PROJECT_TONES[Math.max(0, projects.indexOf(project)) % PROJECT_TONES.length]!

  const table = (format: 'tsv' | 'csv'): string =>
    worklog ? formatTable(worklogTable(worklog, groupBy), format) : ''
  const copy = (): void => {
    void navigator.clipboard.writeText(table('tsv')).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }
  const exportCsv = (): void => {
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([table('csv')], { type: 'text/csv' }))
    link.download = `worklog-${frame.buckets[0]!.days[0]}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }
  const nowLabel = PERIODS.find((item) => item.id === period)!.now

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="m-0 text-[17px] font-semibold tracking-[-0.01em] text-ink">
            {frame.title}
          </h1>
          <span className="text-[12px] text-dim">{frame.range}</span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div
            role="tablist"
            aria-label="Period"
            className="flex h-7 items-center gap-0.5 rounded-lg border border-edge-strong bg-chrome p-0.5"
          >
            {PERIODS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={period === item.id}
                className={tabClass(period === item.id)}
                onClick={() => {
                  setPeriod(item.id)
                  setOffset(0)
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              title="Previous"
              aria-label="Previous"
              className={iconButton}
              onClick={() => setOffset((value) => value + 1)}
            >
              <Chevron back />
            </button>
            {offset > 0 ? (
              <Button className="h-7" onClick={() => setOffset(0)}>
                {nowLabel}
              </Button>
            ) : null}
            <button
              type="button"
              title="Next"
              aria-label="Next"
              disabled={offset === 0}
              className={iconButton}
              onClick={() => setOffset((value) => Math.max(0, value - 1))}
            >
              <Chevron />
            </button>
          </div>
        </div>
      </div>

      {worklog ? (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-2">
            {summaryCards(worklog).map((card) => (
              <div
                key={card.label}
                className="flex min-w-0 flex-col gap-1.5 rounded-[10px] border border-edge bg-panel/80 px-3.5 py-3"
              >
                <span className="flex items-center gap-[7px] text-[12px] font-medium text-dim">
                  <span
                    aria-hidden
                    className="size-[7px] rounded-full"
                    style={{ background: card.tone }}
                  />
                  {card.label}
                </span>
                <span className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[24px] leading-none font-semibold">
                    {card.value}
                  </span>
                  <span className="text-[12px] text-faint">{card.unit}</span>
                </span>
                <span title={card.hint} className="truncate text-[11.5px] text-faint">
                  {card.hint || ' '}
                </span>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <WorklogChart worklog={worklog} projects={projects} colorOf={colorOf} />
            <ProjectBreakdown worklog={worklog} colorOf={colorOf} />
          </div>

          <section className="flex min-w-0 shrink-0 flex-col rounded-xl border border-edge bg-panel/80">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge px-4 py-3">
              <h2 className="m-0 text-[12.5px] font-semibold text-ink">Worklog</h2>
              <span className="text-[11.5px] text-faint">
                {groupBy === 'project'
                  ? 'Tokens per project — click a project to collapse it'
                  : 'Tokens and sessions per task'}
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <div
                  role="tablist"
                  aria-label="Group by"
                  className="flex h-7 items-center gap-0.5 rounded-lg border border-edge-strong bg-chrome p-0.5"
                >
                  <span className="pr-1.5 pl-2 text-[11.5px] text-faint">Group by</span>
                  {(['task', 'project'] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={groupBy === key}
                      className={tabClass(groupBy === key)}
                      onClick={() => setGroupBy(key)}
                    >
                      {key === 'task' ? 'Task' : 'Project'}
                    </button>
                  ))}
                </div>
                <Button className="h-7" disabled={worklog.rows.length === 0} onClick={exportCsv}>
                  Export CSV
                </Button>
                <Button
                  variant="primary"
                  className="h-7"
                  disabled={worklog.rows.length === 0}
                  onClick={copy}
                >
                  {copied ? 'Copied ✓' : 'Copy table'}
                </Button>
              </div>
            </header>
            <WorklogTable
              worklog={worklog}
              groupBy={groupBy}
              collapsed={collapsed}
              colorOf={colorOf}
              onToggleGroup={(project) =>
                setCollapsed((current) => {
                  const next = new Set(current)
                  if (next.has(project)) next.delete(project)
                  else next.add(project)
                  return next
                })
              }
            />
          </section>
        </>
      ) : (
        <p className="m-0 text-[12px] text-dim">Reading the worklog…</p>
      )}
    </div>
  )
}
