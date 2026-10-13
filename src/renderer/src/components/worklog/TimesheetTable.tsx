import type { CSSProperties, ReactNode } from 'react'
import { formatHours, type Worklog, type WorklogBucket, type WorklogRow } from '@core/worklog.js'

const TODAY_TINT = 'bg-accent/10'
const WARN_TEXT = 'text-[var(--color-col-review-text)]'
const OK_TEXT = 'text-[var(--color-col-done)]'

/** A line of the table: a task, or a project heading its tasks. */
interface Line {
  key: string
  id: string
  title: string
  color: string
  cells: number[]
  total: number
  group?: { open: boolean; count: number; toggle: () => void }
  nested?: boolean
}

function diffCell(bucket: WorklogBucket): { text: string; className: string } {
  if (!bucket.target) return { text: '', className: 'text-faint' }
  if (bucket.future)
    return { text: `${formatHours(bucket.target)} due`, className: 'text-faint/60' }
  const short = bucket.target - bucket.total
  if (short <= 1e-9) return { text: '✓', className: OK_TEXT }
  if (bucket.hasToday) return { text: `${formatHours(short)} left`, className: 'text-dim' }
  return {
    text: `−${formatHours(short)}`,
    className: `${WARN_TEXT} bg-[var(--color-col-review)]/10`
  }
}

/** The timesheet: hours per task (or project) per column, the Logged line and how it meets target. */
export function TimesheetTable({
  worklog,
  groupBy,
  collapsed,
  onToggleGroup,
  colorOf
}: {
  worklog: Worklog
  groupBy: 'task' | 'project'
  collapsed: ReadonlySet<string>
  onToggleGroup: (project: string) => void
  colorOf: (project: string) => string
}): ReactNode {
  const count = worklog.buckets.length
  const grid: CSSProperties = {
    gridTemplateColumns: `minmax(220px,1fr) repeat(${count}, minmax(56px,72px)) 80px`
  }
  const tinted = (bucket: WorklogBucket): boolean =>
    worklog.period === 'day' || (bucket.hasToday && worklog.period !== 'month')
  const tint = (bucket: WorklogBucket): string => (tinted(bucket) ? TODAY_TINT : '')

  const taskLine = (row: WorklogRow, nested = false): Line => ({
    key: row.taskId,
    id: row.taskId,
    title: row.title,
    color: colorOf(row.project),
    cells: row.cells,
    total: row.total,
    nested
  })
  const lines: Line[] =
    groupBy === 'project'
      ? worklog.groups.flatMap((group) => {
          const open = !collapsed.has(group.project)
          const head: Line = {
            key: `project:${group.project}`,
            id: '',
            title: group.project,
            color: colorOf(group.project),
            cells: group.cells,
            total: group.total,
            group: { open, count: group.rows.length, toggle: () => onToggleGroup(group.project) }
          }
          return [head, ...(open ? group.rows.map((row) => taskLine(row, true)) : [])]
        })
      : worklog.rows.map((row) => taskLine(row))

  const diffTotal =
    worklog.target === 0
      ? { text: '', className: '' }
      : worklog.left > 1e-9
        ? {
            text: worklog.current
              ? `${formatHours(worklog.left)} to log`
              : `−${formatHours(worklog.left)}`,
            className: WARN_TEXT
          }
        : { text: `✓ ${formatHours(worklog.target)}`, className: OK_TEXT }

  return (
    <div className="overflow-x-auto">
      <div
        className="flex flex-col px-2 pt-1.5 pb-2 text-[12.5px]"
        style={{ minWidth: `${220 + count * 60 + 100}px` }}
      >
        <div className="grid h-9 items-center text-[11.5px] text-faint" style={grid}>
          <span className="px-2">{groupBy === 'project' ? 'Project' : 'Task'}</span>
          {worklog.buckets.map((bucket) => (
            <span
              key={bucket.days[0]}
              className={`flex h-full flex-col items-end justify-center rounded-t-md px-2 leading-tight ${
                tinted(bucket) ? `${TODAY_TINT} font-semibold text-ink` : ''
              }`}
            >
              {bucket.label}
              <span className="text-[10.5px] opacity-80">{bucket.sub}</span>
            </span>
          ))}
          <span className="px-2 text-right">Total</span>
        </div>

        {lines.length === 0 ? (
          <div className="border-t border-edge px-2 py-4 text-[12px] text-faint">
            No time on any task in this period. Hours appear as agents run and tasks get notes or
            commits.
          </div>
        ) : null}

        {lines.map((line) => {
          const Row = line.group ? 'button' : 'div'
          return (
            <Row
              key={line.key}
              {...(line.group
                ? {
                    type: 'button' as const,
                    onClick: line.group.toggle,
                    'aria-expanded': line.group.open
                  }
                : {})}
              className={`grid h-9 items-center border-t border-edge text-left hover:bg-raised/45 ${
                line.group ? 'cursor-pointer bg-raised/30' : ''
              }`}
              style={grid}
            >
              <span
                className={`flex min-w-0 items-center gap-2 pr-2 ${line.nested ? 'pl-10' : 'pl-2'}`}
              >
                {line.group ? (
                  <svg
                    aria-hidden
                    viewBox="0 0 10 10"
                    width="9"
                    height="9"
                    className={`shrink-0 text-dim transition-transform ${line.group.open ? '' : '-rotate-90'}`}
                  >
                    <path
                      d="M2 3.5 5 6.5 8 3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
                <span
                  aria-hidden
                  className={`shrink-0 rounded-full ${line.group ? 'size-2' : 'size-1.5'}`}
                  style={{ background: line.color }}
                />
                {line.id ? (
                  <span className="shrink-0 font-mono text-[10.5px] text-faint">{line.id}</span>
                ) : null}
                <span
                  title={line.title}
                  className={`min-w-0 truncate text-ink ${line.group ? 'font-semibold' : ''}`}
                >
                  {line.title}
                </span>
                {line.group ? (
                  <span className="inline-flex h-[18px] shrink-0 items-center rounded-md bg-raised px-1.5 font-mono text-[10.5px] text-dim">
                    {line.group.count} {line.group.count === 1 ? 'task' : 'tasks'}
                  </span>
                ) : null}
              </span>
              {line.cells.map((hours, index) => (
                <span
                  key={worklog.buckets[index]!.days[0]}
                  className={`flex h-full items-center justify-end px-2 font-mono text-[12px] ${
                    line.group ? 'font-semibold' : ''
                  } ${hours ? 'text-ink' : 'text-faint/60'} ${tint(worklog.buckets[index]!)}`}
                >
                  {hours ? formatHours(hours) : '·'}
                </span>
              ))}
              <span className="px-2 text-right font-mono text-[12px] font-semibold text-ink">
                {formatHours(line.total)}
              </span>
            </Row>
          )
        })}

        <div
          className="grid h-9 items-center border-t border-edge-strong font-semibold"
          style={grid}
        >
          <span className="px-2 text-dim">Logged</span>
          {worklog.buckets.map((bucket) => (
            <span
              key={bucket.days[0]}
              className={`flex h-full items-center justify-end px-2 font-mono text-[12px] ${
                bucket.future ? 'text-faint/60' : 'text-ink'
              } ${tint(bucket)}`}
            >
              {bucket.future ? '—' : formatHours(bucket.total)}
            </span>
          ))}
          <span className="px-2 text-right font-mono text-[12.5px] text-ink">
            {formatHours(worklog.logged)}
          </span>
        </div>
        <div className="grid h-8 items-center" style={grid}>
          <span className="px-2 text-[11.5px] text-faint">vs target</span>
          {worklog.buckets.map((bucket) => {
            const diff = diffCell(bucket)
            return (
              <span
                key={bucket.days[0]}
                className={`flex h-full items-center justify-end whitespace-nowrap rounded-b-md px-2 font-mono text-[11px] font-semibold ${tint(bucket)} ${diff.className}`}
              >
                {diff.text}
              </span>
            )
          })}
          <span
            className={`whitespace-nowrap px-2 text-right font-mono text-[11px] font-semibold ${diffTotal.className}`}
          >
            {diffTotal.text}
          </span>
        </div>
      </div>
    </div>
  )
}
