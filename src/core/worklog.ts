/**
 * The Worklog: how much agent work each task took, per day — the tokens its sessions used and how
 * many sessions ran. Derived, never stored — the main process reads each task's sessions'
 * transcripts into `WorklogTask`s (`worklogSources.ts`) and everything from there on is here,
 * pure, so the renderer can import it.
 *
 * Days are local calendar days, keyed `YYYY-MM-DD`. Weeks start on Monday; weekday indexes are
 * Monday-first (0 = Monday).
 */
import type { WorklogPeriod, WorklogSessionDay, WorklogTask } from './types.js'

/** The label for tasks without a `project`. */
export const NO_PROJECT = 'No project'

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DOW_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** The local calendar day of an instant. */
export function dayKey(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dateOf(day: string): Date {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year!, month! - 1, date!)
}

export function addDays(day: string, count: number): string {
  const date = dateOf(day)
  date.setDate(date.getDate() + count)
  return dayKey(date.getTime())
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(day: string): number {
  return (dateOf(day).getDay() + 6) % 7
}

function shortDate(day: string): string {
  const date = dateOf(day)
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`
}

/** The Monday of the week holding `day`. */
export function weekStartOf(day: string): string {
  return addDays(day, -weekdayOf(day))
}

/** A column of the table or a bar of the chart: one day, or one week of a month. */
export interface FrameBucket {
  days: string[]
  label: string
  sub: string
}

/** What a period at an offset covers, before any use is counted. */
export interface WorklogFrame {
  period: WorklogPeriod
  title: string
  range: string
  chartTitle: string
  /** The table's columns; together they hold the period's days. */
  buckets: FrameBucket[]
  /** The chart's bars. The day view charts the week around its day. */
  chart: FrameBucket[]
  /** The day the day view shows, which its chart rings. */
  selectedDay?: string
  /** The span to fetch, covering both the buckets and the chart (epoch ms, end exclusive). */
  from: number
  to: number
}

function dayBucket(day: string): FrameBucket {
  return { days: [day], label: DOW[weekdayOf(day)]!, sub: String(dateOf(day).getDate()) }
}

/** `offset` counts periods back from the one holding `now`. */
export function worklogFrame(period: WorklogPeriod, offset: number, now: number): WorklogFrame {
  const today = dayKey(now)
  const week = (start: string): FrameBucket[] =>
    [0, 1, 2, 3, 4, 5, 6].map((index) => dayBucket(addDays(start, index)))
  let frame: Omit<WorklogFrame, 'from' | 'to'>
  if (period === 'day') {
    const day = addDays(today, -offset)
    const date = dateOf(day)
    const weekday = weekdayOf(day)
    const start = weekStartOf(day)
    frame = {
      period,
      title: offset === 0 ? 'Today' : offset === 1 ? 'Yesterday' : DOW_LONG[weekday]!,
      range: `${DOW[weekday]}, ${shortDate(day)}, ${date.getFullYear()}`,
      chartTitle: `Week of ${shortDate(start)}`,
      buckets: [{ days: [day], label: 'Tokens', sub: '' }],
      chart: week(start),
      selectedDay: day
    }
  } else if (period === 'week') {
    const start = addDays(weekStartOf(today), -7 * offset)
    const end = addDays(start, 6)
    const buckets = week(start)
    frame = {
      period,
      title:
        offset === 0 ? 'This week' : offset === 1 ? 'Last week' : `Week of ${shortDate(start)}`,
      range: `${shortDate(start)} – ${shortDate(end)}, ${dateOf(end).getFullYear()}`,
      chartTitle: 'Tokens per day',
      buckets,
      chart: buckets
    }
  } else {
    const anchor = dateOf(today)
    const first = new Date(anchor.getFullYear(), anchor.getMonth() - offset, 1)
    const firstDay = dayKey(first.getTime())
    const days: string[] = []
    for (let day = firstDay; dateOf(day).getMonth() === first.getMonth(); day = addDays(day, 1)) {
      days.push(day)
    }
    const weeks = new Map<string, string[]>()
    for (const day of days) {
      const start = weekStartOf(day)
      weeks.set(start, [...(weeks.get(start) ?? []), day])
    }
    const buckets = [...weeks.values()].map((weekDays) => ({
      days: weekDays,
      label: shortDate(weekDays[0]!),
      sub: `– ${dateOf(weekDays[weekDays.length - 1]!).getDate()}`
    }))
    frame = {
      period,
      title: `${MONTHS_LONG[first.getMonth()]} ${first.getFullYear()}`,
      range: `${shortDate(firstDay)} – ${shortDate(days[days.length - 1]!)}`,
      chartTitle: 'Tokens per week',
      buckets,
      chart: buckets
    }
  }
  const all = [...frame.buckets, ...frame.chart].flatMap((bucket) => bucket.days).sort()
  return {
    ...frame,
    from: dateOf(all[0]!).getTime(),
    to: dateOf(addDays(all[all.length - 1]!, 1)).getTime()
  }
}

/** A bucket with its use counted. */
export interface WorklogBucket extends FrameBucket {
  tokens: number
  /** Distinct sessions that ran in it. */
  sessions: number
  /** Tokens per project. */
  byProject: Record<string, number>
  /** Starts after today. */
  future: boolean
  hasToday: boolean
}

export interface WorklogRow {
  taskId: string
  title: string
  project: string
  /** Tokens per bucket, in `Worklog.buckets` order. */
  cells: number[]
  tokens: number
  /** Distinct sessions over the period. */
  sessions: number
}

export interface WorklogProjectGroup {
  project: string
  cells: number[]
  tokens: number
  sessions: number
  rows: WorklogRow[]
}

export interface Worklog extends Omit<WorklogFrame, 'buckets' | 'chart'> {
  buckets: WorklogBucket[]
  chart: WorklogBucket[]
  /** Tasks with a session in the period, most tokens first. */
  rows: WorklogRow[]
  /** Projects with a session in the period, most tokens first. */
  groups: WorklogProjectGroup[]
  tokens: number
  sessions: number
  /** The period's day with the most tokens, if any were used. */
  busiest?: { day: string; tokens: number }
}

/** Tokens and session ids within a set of days. */
function countIn(
  sessions: readonly WorklogSessionDay[],
  days: ReadonlySet<string>
): { tokens: number; ids: Set<string> } {
  let tokens = 0
  const ids = new Set<string>()
  for (const entry of sessions) {
    if (!days.has(entry.day)) continue
    tokens += entry.tokens
    ids.add(entry.sessionId)
  }
  return { tokens, ids }
}

/** Counts each task's sessions into `frame`. */
export function buildWorklog(
  frame: WorklogFrame,
  tasks: readonly WorklogTask[],
  now: number
): Worklog {
  const today = dayKey(now)
  const projectOf = (task: WorklogTask): string => task.project?.trim() || NO_PROJECT

  const measure = (bucket: FrameBucket): WorklogBucket => {
    const days = new Set(bucket.days)
    const byProject: Record<string, number> = {}
    const ids = new Set<string>()
    let tokens = 0
    for (const task of tasks) {
      const counted = countIn(task.sessions, days)
      for (const id of counted.ids) ids.add(id)
      if (!counted.tokens) continue
      tokens += counted.tokens
      byProject[projectOf(task)] = (byProject[projectOf(task)] ?? 0) + counted.tokens
    }
    return {
      ...bucket,
      tokens,
      sessions: ids.size,
      byProject,
      future: bucket.days[0]! > today,
      hasToday: bucket.days.includes(today)
    }
  }
  const buckets = frame.buckets.map(measure)
  const chart = frame.chart === frame.buckets ? buckets : frame.chart.map(measure)

  const periodDays = buckets.flatMap((bucket) => bucket.days)
  const inPeriod = new Set(periodDays)
  const rows = tasks
    .map((task): WorklogRow => {
      const cells = buckets.map((bucket) => countIn(task.sessions, new Set(bucket.days)).tokens)
      return {
        taskId: task.taskId,
        title: task.title,
        project: projectOf(task),
        cells,
        tokens: cells.reduce((sum, tokens) => sum + tokens, 0),
        sessions: countIn(task.sessions, inPeriod).ids.size
      }
    })
    .filter((row) => row.sessions > 0)
    .sort(
      (a, b) => b.tokens - a.tokens || b.sessions - a.sessions || a.taskId.localeCompare(b.taskId)
    )

  const groups = new Map<string, WorklogProjectGroup>()
  for (const row of rows) {
    const group = groups.get(row.project) ?? {
      project: row.project,
      cells: buckets.map(() => 0),
      tokens: 0,
      sessions: 0,
      rows: []
    }
    group.rows.push(row)
    group.cells = group.cells.map((tokens, index) => tokens + row.cells[index]!)
    group.tokens += row.tokens
    group.sessions += row.sessions
    groups.set(row.project, group)
  }

  let busiest: Worklog['busiest']
  for (const day of periodDays) {
    const tokens = tasks.reduce(
      (sum, task) => sum + countIn(task.sessions, new Set([day])).tokens,
      0
    )
    if (tokens > (busiest?.tokens ?? 0)) busiest = { day, tokens }
  }

  return {
    ...frame,
    buckets,
    chart,
    rows,
    groups: [...groups.values()].sort(
      (a, b) => b.tokens - a.tokens || b.sessions - a.sessions || a.project.localeCompare(b.project)
    ),
    tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    sessions: rows.reduce((sum, row) => sum + row.sessions, 0),
    busiest
  }
}

/** `850`, `12.3k`, `456k`, `1.25M`, `12.5M`: a token count at a glance. */
export function formatTokens(tokens: number): string {
  const trim = (value: string): string => value.replace(/\.0+$/, '')
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 100_000) return `${trim((tokens / 1000).toFixed(1))}k`
  if (tokens < 999_500) return `${Math.round(tokens / 1000)}k`
  if (tokens < 10_000_000) return `${trim((tokens / 1_000_000).toFixed(2))}M`
  return `${trim((tokens / 1_000_000).toFixed(1))}M`
}

/** `Tue Oct 13`, for naming a day in a sentence. */
export function dayLabel(day: string): string {
  return `${DOW[weekdayOf(day)]} ${shortDate(day)}`
}

/**
 * The table as rows of cells for copying or export: exact token counts per column, then the
 * period's sessions and tokens, with a header and a Total line.
 */
export function worklogTable(worklog: Worklog, groupBy: 'task' | 'project'): string[][] {
  const cells = (tokens: number[]): string[] => tokens.map((value) => (value ? String(value) : ''))
  const taskLine = (row: WorklogRow, indent = ''): string[] => [
    indent + row.taskId,
    row.title,
    row.project,
    ...cells(row.cells),
    String(row.sessions),
    String(row.tokens)
  ]
  const body =
    groupBy === 'project'
      ? worklog.groups.flatMap((group) => [
          [
            group.project,
            '',
            group.project,
            ...cells(group.cells),
            String(group.sessions),
            String(group.tokens)
          ],
          ...group.rows.map((row) => taskLine(row, '  '))
        ])
      : worklog.rows.map((row) => taskLine(row))
  return [
    [
      'Task',
      'Title',
      'Project',
      ...worklog.buckets.map((bucket) => `${bucket.label} ${bucket.sub}`.trim()),
      'Sessions',
      'Tokens'
    ],
    ...body,
    [
      '',
      'Total',
      '',
      ...worklog.buckets.map((bucket) => String(bucket.tokens)),
      String(worklog.sessions),
      String(worklog.tokens)
    ]
  ]
}

/** Tab-separated (pastes into a spreadsheet as cells) or CSV. */
export function formatTable(rows: string[][], format: 'tsv' | 'csv'): string {
  if (format === 'tsv') {
    return rows
      .map((row) => row.map((cell) => cell.replace(/[\t\r\n]+/g, ' ')).join('\t'))
      .join('\n')
  }
  const quote = (cell: string): string =>
    /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
  return rows.map((row) => row.map(quote).join(',')).join('\n')
}
