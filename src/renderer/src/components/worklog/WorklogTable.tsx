import type { CSSProperties, ReactNode } from 'react'
import { formatTokens, type Worklog, type WorklogBucket, type WorklogRow } from '@core/worklog.js'

const TODAY_TINT = 'bg-accent/10'

/** A line of the table: a task, or a project heading its tasks. */
interface Line {
  key: string
  id: string
  title: string
  color: string
  cells: number[]
  tokens: number
  sessions: number
  group?: { open: boolean; count: number; toggle: () => void }
  nested?: boolean
}

/** Tokens per task (or project) per column, its sessions and tokens over the period, and the totals. */
export function WorklogTable({
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
    gridTemplateColumns: `minmax(220px,1fr) repeat(${count}, minmax(56px,72px)) 72px 80px`
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
    tokens: row.tokens,
    sessions: row.sessions,
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
            tokens: group.tokens,
            sessions: group.sessions,
            group: { open, count: group.rows.length, toggle: () => onToggleGroup(group.project) }
          }
          return [head, ...(open ? group.rows.map((row) => taskLine(row, true)) : [])]
        })
      : worklog.rows.map((row) => taskLine(row))

  return (
    <div className="overflow-x-auto">
      <div
        className="flex flex-col px-2 pt-1.5 pb-2 text-[12.5px]"
        style={{ minWidth: `${220 + count * 60 + 172}px` }}
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
          <span className="px-2 text-right">Sessions</span>
          <span className="px-2 text-right">Tokens</span>
        </div>

        {lines.length === 0 ? (
          <div className="border-t border-edge px-2 py-4 text-[12px] text-faint">
            No agent sessions on any task in this period. Tokens and sessions appear as agents run.
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
              {line.cells.map((tokens, index) => (
                <span
                  key={worklog.buckets[index]!.days[0]}
                  title={tokens ? `${tokens.toLocaleString()} tokens` : undefined}
                  className={`flex h-full items-center justify-end px-2 font-mono text-[12px] ${
                    line.group ? 'font-semibold' : ''
                  } ${tokens ? 'text-ink' : 'text-faint/60'} ${tint(worklog.buckets[index]!)}`}
                >
                  {tokens ? formatTokens(tokens) : '·'}
                </span>
              ))}
              <span className="px-2 text-right font-mono text-[12px] text-dim">
                {line.sessions}
              </span>
              <span
                title={`${line.tokens.toLocaleString()} tokens`}
                className="px-2 text-right font-mono text-[12px] font-semibold text-ink"
              >
                {formatTokens(line.tokens)}
              </span>
            </Row>
          )
        })}

        <div
          className="grid h-9 items-center border-t border-edge-strong font-semibold"
          style={grid}
        >
          <span className="px-2 text-dim">Total</span>
          {worklog.buckets.map((bucket) => (
            <span
              key={bucket.days[0]}
              className={`flex h-full items-center justify-end rounded-b-md px-2 font-mono text-[12px] ${
                bucket.future ? 'text-faint/60' : 'text-ink'
              } ${tint(bucket)}`}
            >
              {bucket.future ? '—' : formatTokens(bucket.tokens)}
            </span>
          ))}
          <span className="px-2 text-right font-mono text-[12.5px] text-ink">
            {worklog.sessions}
          </span>
          <span
            title={`${worklog.tokens.toLocaleString()} tokens`}
            className="px-2 text-right font-mono text-[12.5px] text-ink"
          >
            {formatTokens(worklog.tokens)}
          </span>
        </div>
      </div>
    </div>
  )
}
