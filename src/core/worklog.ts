/**
 * The Worklog: how long each task was worked on, per day, measured against the person's working
 * hours (`TimesheetSettings`). Derived, never stored — the main process turns a task's trail into
 * `WorklogTask` intervals (`worklogSources.ts`) and everything from there on is here, pure, so the
 * renderer can import it.
 *
 * Days are local calendar days, keyed `YYYY-MM-DD`. Weekday indexes are Monday-first (0 = Monday),
 * matching `TimesheetSettings.workingDays`.
 */
import type {
  TimesheetSettings,
  WorklogDaySuggestions,
  WorklogPeriod,
  WorklogTask
} from './types.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Two signals this close together are one stretch of work; a longer silence is a break. */
export const IDLE_GAP_MS = 20 * MINUTE
/** What a signal opening a stretch counts for: the work just before it (reading, typing a prompt). */
export const LEAD_MS = 5 * MINUTE

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

/**
 * Activity timestamps (epoch ms) as stretches of work: signals within `IDLE_GAP_MS` of each other
 * join one stretch, and each stretch starts `LEAD_MS` before its first signal. Sorted and disjoint.
 */
export function workIntervals(times: readonly number[]): [number, number][] {
  const sorted = times.filter(Number.isFinite).sort((a, b) => a - b)
  const stretches: [number, number][] = []
  for (const at of sorted) {
    const last = stretches[stretches.length - 1]
    if (last && at - last[1] <= IDLE_GAP_MS) last[1] = at
    else stretches.push([at - LEAD_MS, at])
  }
  return stretches
}

/** `intervals` cut to `[from, to)`; empty pieces drop out. */
export function clipIntervals(
  intervals: readonly [number, number][],
  from: number,
  to: number
): [number, number][] {
  return intervals
    .map(([start, end]): [number, number] => [Math.max(start, from), Math.min(end, to)])
    .filter(([start, end]) => end > start)
}

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

function nextMidnight(ms: number): number {
  const date = new Date(ms)
  date.setHours(24, 0, 0, 0)
  return date.getTime()
}

/**
 * Hours per task per day. Time two tasks were worked on at once (two agents running side by side)
 * is shared evenly between them, so a day never holds more hours than it had.
 */
export function hoursByTaskDay(tasks: readonly WorklogTask[]): Map<string, Map<string, number>> {
  const edges: { at: number; taskId: string; opens: boolean }[] = []
  for (const task of tasks) {
    for (const [start, end] of task.intervals) {
      // Cut at midnight, so every stretch between two edges lies within one day.
      for (let from = start; from < end;) {
        const to = Math.min(end, nextMidnight(from))
        edges.push({ at: from, taskId: task.taskId, opens: true })
        edges.push({ at: to, taskId: task.taskId, opens: false })
        from = to
      }
    }
  }
  // Closing before opening at the same instant: a task's pieces meeting at midnight stay one task.
  edges.sort((a, b) => a.at - b.at || Number(a.opens) - Number(b.opens))

  const hours = new Map<string, Map<string, number>>()
  const active = new Set<string>()
  let previous = edges[0]?.at ?? 0
  for (const edge of edges) {
    if (edge.at > previous && active.size > 0) {
      const share = (edge.at - previous) / active.size / HOUR
      const day = dayKey(previous)
      for (const taskId of active) {
        const days = hours.get(taskId) ?? new Map<string, number>()
        days.set(day, (days.get(day) ?? 0) + share)
        hours.set(taskId, days)
      }
    }
    previous = edge.at
    if (edge.opens) active.add(edge.taskId)
    else active.delete(edge.taskId)
  }
  return hours
}

/** To the nearest `minutes`; 0 leaves the value exact. */
export function roundHours(hours: number, minutes: number): number {
  if (!minutes) return hours
  return (Math.round((hours * 60) / minutes) * minutes) / 60
}

/** `7.75`, `8.0`, `0.5` — two decimals at most, and a whole hour keeps its `.0`. */
export function formatHours(hours: number): string {
  const value = Math.round(hours * 100) / 100
  return value % 1 === 0 ? value.toFixed(1) : String(value)
}

function shortDate(day: string): string {
  const date = dateOf(day)
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`
}

/** The first day of the week holding `day`. */
export function weekStartOf(day: string, weekStart: TimesheetSettings['weekStart']): string {
  const weekday = weekdayOf(day)
  return addDays(day, -(weekStart === 'mon' ? weekday : (weekday + 1) % 7))
}

/** A column of the timesheet or a bar of the chart: one day, or one week of a month. */
export interface FrameBucket {
  days: string[]
  label: string
  sub: string
}

/** What a period at an offset covers, before any hours are counted. */
export interface WorklogFrame {
  period: WorklogPeriod
  title: string
  range: string
  chartTitle: string
  /** The timesheet's columns; together they hold the period's days. */
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
export function worklogFrame(
  period: WorklogPeriod,
  offset: number,
  now: number,
  weekStart: TimesheetSettings['weekStart']
): WorklogFrame {
  const today = dayKey(now)
  const week = (start: string): FrameBucket[] =>
    [0, 1, 2, 3, 4, 5, 6].map((index) => dayBucket(addDays(start, index)))
  let frame: Omit<WorklogFrame, 'from' | 'to'>
  if (period === 'day') {
    const day = addDays(today, -offset)
    const date = dateOf(day)
    const weekday = weekdayOf(day)
    const start = weekStartOf(day, weekStart)
    frame = {
      period,
      title: offset === 0 ? 'Today' : offset === 1 ? 'Yesterday' : DOW_LONG[weekday]!,
      range: `${DOW[weekday]}, ${shortDate(day)}, ${date.getFullYear()}`,
      chartTitle: `Week of ${shortDate(start)}`,
      buckets: [{ days: [day], label: 'Hours', sub: '' }],
      chart: week(start),
      selectedDay: day
    }
  } else if (period === 'week') {
    const start = addDays(weekStartOf(today, weekStart), -7 * offset)
    const end = addDays(start, 6)
    const buckets = week(start)
    frame = {
      period,
      title:
        offset === 0 ? 'This week' : offset === 1 ? 'Last week' : `Week of ${shortDate(start)}`,
      range: `${shortDate(start)} – ${shortDate(end)}, ${dateOf(end).getFullYear()}`,
      chartTitle: 'Hours per day',
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
      const start = weekStartOf(day, weekStart)
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
      chartTitle: 'Hours per week',
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

/** A bucket with its hours counted. */
export interface WorklogBucket extends FrameBucket {
  /** Hours the working days in it ask for. */
  target: number
  total: number
  byProject: Record<string, number>
  /** Starts after today. */
  future: boolean
  hasToday: boolean
}

export interface WorklogRow {
  taskId: string
  title: string
  project: string
  /** Hours per bucket, in `Worklog.buckets` order. */
  cells: number[]
  total: number
}

export interface WorklogProjectGroup {
  project: string
  cells: number[]
  total: number
  rows: WorklogRow[]
}

export interface Worklog extends Omit<WorklogFrame, 'buckets' | 'chart'> {
  buckets: WorklogBucket[]
  chart: WorklogBucket[]
  /** Tasks with time in the period, most hours first. */
  rows: WorklogRow[]
  /** Projects with time in the period, most hours first. */
  groups: WorklogProjectGroup[]
  logged: number
  target: number
  /** Target hours not yet logged. */
  left: number
  /** The period holds today, so some of `left` may still be worked. */
  current: boolean
  /** Of `left`, what today's own target still asks for. */
  todayLeft: number
  /** Past working days short of a full day, with how short. */
  gaps: { day: string; short: number }[]
}

/** What a timesheet line is about: a task, or a free-standing entry a suggestion added. */
export type WorklogTaskInfo = Pick<WorklogTask, 'taskId' | 'title' | 'project'>

/** Hours per task per day, and the tasks they belong to: measured or suggested. */
export interface WorklogHours {
  tasks: WorklogTaskInfo[]
  byTaskDay: Map<string, Map<string, number>>
  /** A suggested entry's note, by task then day. */
  notes?: Map<string, Map<string, string>>
}

/** The time measured from the tasks' trails, shared between tasks worked on at once. */
export function measuredHours(tasks: readonly WorklogTask[]): WorklogHours {
  return { tasks: [...tasks], byTaskDay: hoursByTaskDay(tasks) }
}

/**
 * The hours an agent suggested. `info` names the tasks it mentions; an id it does not know (an
 * entry such as meetings) keeps the id as its title.
 */
export function suggestedHours(
  days: readonly WorklogDaySuggestions[],
  info: (taskId: string) => WorklogTaskInfo | undefined
): WorklogHours {
  const byTaskDay = new Map<string, Map<string, number>>()
  const notes = new Map<string, Map<string, string>>()
  const tasks = new Map<string, WorklogTaskInfo>()
  for (const { day, entries } of days) {
    for (const entry of entries) {
      if (!tasks.has(entry.taskId)) {
        tasks.set(entry.taskId, info(entry.taskId) ?? { taskId: entry.taskId, title: entry.taskId })
      }
      const hours = byTaskDay.get(entry.taskId) ?? new Map<string, number>()
      hours.set(day, (hours.get(day) ?? 0) + entry.hours)
      byTaskDay.set(entry.taskId, hours)
      if (entry.note) {
        const taskNotes = notes.get(entry.taskId) ?? new Map<string, string>()
        taskNotes.set(day, entry.note)
        notes.set(entry.taskId, taskNotes)
      }
    }
  }
  return { tasks: [...tasks.values()], byTaskDay, notes }
}

/** Counts `hours` into `frame`, rounding each task's day by the timesheet. */
export function buildWorklog(
  frame: WorklogFrame,
  hours: WorklogHours,
  timesheet: TimesheetSettings,
  now: number
): Worklog {
  const today = dayKey(now)
  const working = (day: string): boolean => timesheet.workingDays[weekdayOf(day)] === true
  const { tasks, byTaskDay } = hours
  const hoursOn = (taskId: string, day: string): number =>
    roundHours(byTaskDay.get(taskId)?.get(day) ?? 0, timesheet.roundMinutes)
  const projectOf = (task: WorklogTaskInfo): string => task.project?.trim() || NO_PROJECT
  const dayTotal = (day: string): number =>
    tasks.reduce((sum, task) => sum + hoursOn(task.taskId, day), 0)

  const measure = (bucket: FrameBucket): WorklogBucket => {
    const byProject: Record<string, number> = {}
    let total = 0
    for (const task of tasks) {
      const hours = bucket.days.reduce((sum, day) => sum + hoursOn(task.taskId, day), 0)
      if (!hours) continue
      total += hours
      byProject[projectOf(task)] = (byProject[projectOf(task)] ?? 0) + hours
    }
    return {
      ...bucket,
      target: bucket.days.filter(working).length * timesheet.hoursPerDay,
      total,
      byProject,
      future: bucket.days[0]! > today,
      hasToday: bucket.days.includes(today)
    }
  }
  const buckets = frame.buckets.map(measure)
  const chart = frame.chart === frame.buckets ? buckets : frame.chart.map(measure)

  const rows = tasks
    .map((task) => {
      const cells = buckets.map((bucket) =>
        bucket.days.reduce((sum, day) => sum + hoursOn(task.taskId, day), 0)
      )
      return {
        taskId: task.taskId,
        title: task.title,
        project: projectOf(task),
        cells,
        total: cells.reduce((sum, hours) => sum + hours, 0)
      }
    })
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total || a.taskId.localeCompare(b.taskId))

  const groups = new Map<string, WorklogProjectGroup>()
  for (const row of rows) {
    const group = groups.get(row.project) ?? {
      project: row.project,
      cells: buckets.map(() => 0),
      total: 0,
      rows: []
    }
    group.rows.push(row)
    group.cells = group.cells.map((hours, index) => hours + row.cells[index]!)
    group.total += row.total
    groups.set(row.project, group)
  }

  const periodDays = buckets.flatMap((bucket) => bucket.days)
  const logged = rows.reduce((sum, row) => sum + row.total, 0)
  const target = buckets.reduce((sum, bucket) => sum + bucket.target, 0)
  const current = periodDays.includes(today)
  return {
    ...frame,
    buckets,
    chart,
    rows,
    groups: [...groups.values()].sort(
      (a, b) => b.total - a.total || a.project.localeCompare(b.project)
    ),
    logged,
    target,
    left: Math.max(0, target - logged),
    current,
    todayLeft: current && working(today) ? Math.max(0, timesheet.hoursPerDay - dayTotal(today)) : 0,
    gaps: periodDays
      .filter((day) => day < today && working(day))
      .map((day) => ({ day, short: timesheet.hoursPerDay - dayTotal(day) }))
      .filter((gap) => gap.short > 1e-9)
  }
}

/** `Tue Oct 13`, for naming a day in a sentence. */
export function dayLabel(day: string): string {
  return `${DOW[weekdayOf(day)]} ${shortDate(day)}`
}

/** The timesheet as rows of cells, header and Logged line included, for copying or export. */
export function timesheetTable(
  worklog: Worklog,
  groupBy: TimesheetSettings['groupBy']
): string[][] {
  const cells = (hours: number[]): string[] =>
    hours.map((value) => (value ? formatHours(value) : ''))
  const taskLine = (row: WorklogRow, indent = ''): string[] => [
    indent + row.taskId,
    row.title,
    row.project,
    ...cells(row.cells),
    formatHours(row.total)
  ]
  const body =
    groupBy === 'project'
      ? worklog.groups.flatMap((group) => [
          [group.project, '', group.project, ...cells(group.cells), formatHours(group.total)],
          ...group.rows.map((row) => taskLine(row, '  '))
        ])
      : worklog.rows.map((row) => taskLine(row))
  return [
    [
      'Task',
      'Title',
      'Project',
      ...worklog.buckets.map((bucket) => `${bucket.label} ${bucket.sub}`.trim()),
      'Total'
    ],
    ...body,
    [
      '',
      'Logged',
      '',
      ...worklog.buckets.map((bucket) => formatHours(bucket.total)),
      formatHours(worklog.logged)
    ]
  ]
}

/** Tab-separated (pastes into a spreadsheet as cells) or CSV. */
export function formatTable(rows: string[][], format: TimesheetSettings['copyFormat']): string {
  if (format === 'tsv') {
    return rows
      .map((row) => row.map((cell) => cell.replace(/[\t\r\n]+/g, ' ')).join('\t'))
      .join('\n')
  }
  const quote = (cell: string): string =>
    /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
  return rows.map((row) => row.map(quote).join(',')).join('\n')
}
