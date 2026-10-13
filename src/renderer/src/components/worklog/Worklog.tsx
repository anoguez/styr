import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { shortcutHint } from '@core/shortcuts.js'
import type { ShortcutBindings, TimesheetSettings, WorklogPeriod } from '@core/types.js'
import {
  buildWorklog,
  dayLabel,
  formatHours,
  formatTable,
  timesheetTable,
  worklogFrame,
  type Worklog as WorklogModel
} from '@core/worklog.js'
import { useWorklog } from '../../hooks/useWorklog.js'
import { Button } from '../ui.js'
import { HoursPerDayStepper, WorkingDaysPicker, weeklyTargetLabel } from './TimesheetControls.js'
import { TimesheetTable } from './TimesheetTable.js'
import { ProjectBreakdown, WorklogChart } from './WorklogChart.js'

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

const WARN = 'var(--color-col-review)'
const OK = 'var(--color-col-done)'

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
  progress?: number
  warn?: boolean
}

function summaryCards(worklog: WorklogModel, hoursPerDay: number): SummaryCard[] {
  const percent = worklog.target ? Math.round((worklog.logged / worklog.target) * 100) : 0
  const left = worklog.left > 1e-9
  const gaps = worklog.gaps
  const tasks = worklog.rows.length
  const share = (hours: number): string =>
    `${worklog.logged ? Math.round((hours / worklog.logged) * 100) : 0}%`
  return [
    {
      label: 'Logged',
      tone: 'var(--color-accent-soft)',
      value: formatHours(worklog.logged),
      unit: `of ${formatHours(worklog.target)}h`,
      hint: `${percent}% of target`,
      progress: Math.min(100, percent)
    },
    {
      label: 'Left to log',
      tone: left ? WARN : OK,
      value: formatHours(worklog.left),
      unit: 'h',
      hint: worklog.current
        ? `Incl. ${formatHours(worklog.todayLeft)}h still open today`
        : left
          ? 'Short for this period'
          : 'Fully logged',
      warn: left
    },
    {
      label: 'Days with gaps',
      tone: gaps.length ? WARN : OK,
      value: String(gaps.length),
      unit: gaps.length === 1 ? 'day' : 'days',
      hint: gaps.length
        ? gaps
            .slice(0, 2)
            .map((gap) => `${dayLabel(gap.day)} −${formatHours(gap.short)}h`)
            .join(' · ')
        : `Every past working day hits ${formatHours(hoursPerDay)}h`
    },
    {
      label: 'Tasks worked',
      tone: 'var(--color-col-progress)',
      value: String(tasks),
      unit: tasks === 1 ? 'task' : 'tasks',
      hint: worklog.groups.map((group) => `${group.project} ${share(group.total)}`).join(' · ')
    }
  ]
}

/** The quick timesheet settings behind the header button; the rest live in Settings. */
function TimesheetPopover({
  timesheet,
  bindings,
  onChange,
  onOpenSettings
}: {
  timesheet: TimesheetSettings
  bindings: ShortcutBindings
  onChange: (timesheet: TimesheetSettings) => void
  onOpenSettings: () => void
}): ReactNode {
  return (
    <div
      role="dialog"
      aria-label="Timesheet settings"
      className="absolute top-full right-0 z-40 mt-1.5 flex w-[280px] flex-col rounded-xl border border-edge-strong bg-chrome shadow-[0_16px_40px_-8px_rgba(0,0,0,0.7)]"
    >
      <div className="flex items-baseline gap-2 px-3 pt-3 pb-2.5">
        <span className="text-[12.5px] font-semibold text-ink">Timesheet</span>
        <span className="ml-auto font-mono text-[11.5px] text-dim">
          {weeklyTargetLabel(timesheet)} / week
        </span>
      </div>
      <div className="flex flex-col gap-3 px-3 pb-3">
        <div className="flex items-center gap-2.5">
          <span className="flex-1 text-[12px] text-dim">Hours per day</span>
          <HoursPerDayStepper
            timesheet={timesheet}
            className="w-[104px]"
            onChange={(hoursPerDay) => onChange({ ...timesheet, hoursPerDay })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-dim">Working days</span>
          <WorkingDaysPicker
            stretch
            timesheet={timesheet}
            onChange={(workingDays) => onChange({ ...timesheet, workingDays })}
          />
        </div>
      </div>
      <button
        type="button"
        onClick={onOpenSettings}
        className="flex items-center justify-between rounded-b-xl border-t border-edge px-3 py-2.5 text-left text-[12px] text-dim hover:bg-raised hover:text-ink"
      >
        All timesheet settings
        <kbd className="font-mono text-[10px] text-faint">{shortcutHint(bindings, 'settings')}</kbd>
      </button>
    </div>
  )
}

/**
 * The Worklog: how long each task was worked on, per day, against the working hours in Settings →
 * Timesheet, ready to copy into a timesheet. Every number is derived on the fly (`core/worklog.ts`).
 */
export function Worklog({
  timesheet,
  bindings,
  refresh,
  onTimesheetChange,
  onOpenSettings
}: {
  timesheet: TimesheetSettings
  bindings: ShortcutBindings
  /** Changes whenever the tasks do, so the hours follow the agents' work. */
  refresh: unknown
  onTimesheetChange: (timesheet: TimesheetSettings) => void
  onOpenSettings: () => void
}): ReactNode {
  const [period, setPeriod] = useState<WorklogPeriod>(timesheet.period)
  const [offset, setOffset] = useState(0)
  const [groupBy, setGroupBy] = useState(timesheet.groupBy)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const popover = useRef<HTMLDivElement>(null)

  const now = Date.now()
  const frame = worklogFrame(period, offset, now, timesheet.weekStart)
  const tasks = useWorklog(frame.from, frame.to, refresh)
  const worklog = useMemo(
    () => (tasks ? buildWorklog(frame, tasks, timesheet, now) : null),
    // `frame` and `now` are rebuilt every render; the span and the settings say when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, timesheet, period, offset]
  )

  // Colours follow the project names, sorted, so a project keeps its colour across periods.
  const projects = useMemo(
    () => [...new Set(worklog?.groups.map((group) => group.project) ?? [])].sort(),
    [worklog]
  )
  const colorOf = (project: string): string =>
    PROJECT_TONES[Math.max(0, projects.indexOf(project)) % PROJECT_TONES.length]!

  useEffect(() => {
    if (!popoverOpen) return
    function onPointerDown(event: MouseEvent): void {
      if (!popover.current?.contains(event.target as Node)) setPopoverOpen(false)
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setPopoverOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [popoverOpen])

  const table = (format: TimesheetSettings['copyFormat']): string =>
    worklog ? formatTable(timesheetTable(worklog, groupBy), format) : ''
  const copy = (): void => {
    void navigator.clipboard.writeText(table(timesheet.copyFormat)).then(() => {
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
          <div ref={popover} className="relative">
            <button
              type="button"
              title="Timesheet settings"
              aria-haspopup="dialog"
              aria-expanded={popoverOpen}
              onClick={() => setPopoverOpen((open) => !open)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-lg border border-edge-strong px-2.5 text-[12px] font-medium hover:bg-raised hover:text-ink ${
                popoverOpen ? 'bg-raised text-ink' : 'bg-raised/70 text-dim'
              }`}
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
                <circle cx="8" cy="8" r="2.5" />
                <circle cx="8" cy="8" r="5.6" strokeDasharray="1.7 1.9" />
              </svg>
              <span className="font-mono text-[11.5px]">{weeklyTargetLabel(timesheet)} / week</span>
            </button>
            {popoverOpen ? (
              <TimesheetPopover
                timesheet={timesheet}
                bindings={bindings}
                onChange={onTimesheetChange}
                onOpenSettings={() => {
                  setPopoverOpen(false)
                  onOpenSettings()
                }}
              />
            ) : null}
          </div>
        </div>
      </div>

      {worklog ? (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-2">
            {summaryCards(worklog, timesheet.hoursPerDay).map((card) => (
              <div
                key={card.label}
                className={`flex min-w-0 flex-col gap-1.5 rounded-[10px] border bg-panel/80 px-3.5 py-3 ${
                  card.warn ? 'border-[var(--color-col-review)]/35' : 'border-edge'
                }`}
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
                  <span
                    className="font-mono text-[24px] leading-none font-semibold"
                    style={{ color: card.warn ? 'var(--color-col-review-text)' : undefined }}
                  >
                    {card.value}
                  </span>
                  <span className="text-[12px] text-faint">{card.unit}</span>
                </span>
                {card.progress !== undefined ? (
                  <div className="h-1 overflow-hidden rounded-full bg-raised">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-[var(--color-accent-soft)] to-[var(--color-col-progress)]"
                      style={{ width: `${card.progress}%` }}
                    />
                  </div>
                ) : null}
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
              <h2 className="m-0 text-[12.5px] font-semibold text-ink">Timesheet</h2>
              <span className="text-[11.5px] text-faint">
                {groupBy === 'project'
                  ? 'Hours per project — click a project to collapse it'
                  : 'Hours per task, ready to copy into your timesheet'}
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
                  {copied ? 'Copied ✓' : 'Copy for timesheet'}
                </Button>
              </div>
            </header>
            <TimesheetTable
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
