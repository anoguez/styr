/**
 * The brief for Suggest hours: an agent reads the period's measured time, the tasks behind it and
 * the working hours, and submits hours per task per day that meet the target through the MCP
 * server's `suggest_worklog`. The template is a setting (`TimesheetSettings.suggestPrompt`, empty
 * for this shipped one); `{{name}}` placeholders are filled here. Pure, so the renderer builds it.
 */
import { TASK_STATUS_LABELS, type Task, type TimesheetSettings } from './types.js'
import { dayLabel, formatHours, weekdayOf, type WorklogHours } from './worklog.js'

/** The placeholders a worklog prompt can use, with what each one holds. */
export const WORKLOG_PROMPT_PLACEHOLDERS: { name: string; hint: string }[] = [
  { name: 'period', hint: 'The period, e.g. This week (Oct 12 – Oct 18, 2026)' },
  { name: 'timesheet', hint: 'Hours per day, working days and the target' },
  { name: 'days', hint: 'Each day: working or not, target, measured, today or still to come' },
  { name: 'measured', hint: 'A table of measured hours per task per day' },
  { name: 'tasks', hint: 'Each task worked on, with its notes from the period' },
  { name: 'rounding', hint: 'The step every entry is rounded to' }
]

export const DEFAULT_WORKLOG_PROMPT = `You are filling in a timesheet from the work recorded on a Styr board. Suggest how many hours to log against each task on each day of {{period}}, so the timesheet is a fair account of the work and meets the working hours below.

## Working hours
{{timesheet}}

## Days
{{days}}

## Measured time
Hours Styr measured from agent sessions, activity notes and commits. Time two tasks shared is already split between them, so these add up to clock time, and usually fall short of the target: agents ran in parallel, and work away from an agent is not seen.

{{measured}}

## Tasks
{{tasks}}

## How to distribute
- For every working day up to and including today, suggest entries that add up to that day's target exactly. Days still to come get nothing.
- Spread a day's hours over the tasks worked that day, starting from the measured share and weighting by the effort the titles and notes show: a feature spread over several sessions deserves more than a one-line fix.
- A working day with nothing measured: spread its target over the tasks worked nearest to it, and say so in the notes.
- A day that is not a working day: suggest only what was measured on it, if anything.
- Use only the task ids listed above.
- Round every entry to {{rounding}}.
- Give each entry a short note, a few words on what the time went on, taken from the task's title and notes.

## Submitting
Call \`suggest_worklog\` on the styr MCP server once, with every entry as \`{ day: "YYYY-MM-DD", taskId, hours, note }\`. Each day you submit replaces that day's earlier suggestion. Do not change any task and do not write any file.

If you cannot see the styr MCP tools, do not emulate them: print the entries as a Markdown table and tell the user to run the MCP setup command from Styr's Settings → Agents.`

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const NOTES_PER_TASK = 12
const NOTE_LENGTH = 240

export interface WorklogPromptInput {
  /** `This week (Oct 12 – Oct 18, 2026)`. */
  period: string
  /** Every day of the period, `YYYY-MM-DD`, in order. */
  days: string[]
  today: string
  timesheet: TimesheetSettings
  /** Measured hours, exact (not rounded). */
  measured: WorklogHours
  /** The board's tasks; those measured, or with notes in the period, are described. */
  tasks: readonly Task[]
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
}

function timesheetLines(timesheet: TimesheetSettings): string {
  const working = DOW.filter((_, index) => timesheet.workingDays[index])
  return [
    `- ${formatHours(timesheet.hoursPerDay)}h per working day`,
    `- Working days: ${working.length ? working.join(', ') : 'none'}`,
    `- Weekly target: ${formatHours(timesheet.hoursPerDay * working.length)}h`
  ].join('\n')
}

function dayHours(measured: WorklogHours, day: string): number {
  return measured.tasks.reduce(
    (sum, task) => sum + (measured.byTaskDay.get(task.taskId)?.get(day) ?? 0),
    0
  )
}

function dayLines(input: WorklogPromptInput): string {
  return input.days
    .map((day) => {
      const working = input.timesheet.workingDays[weekdayOf(day)] === true
      const when = day > input.today ? ' (still to come)' : day === input.today ? ' (today)' : ''
      const target = working
        ? `working day, target ${formatHours(input.timesheet.hoursPerDay)}h`
        : 'not a working day'
      return `- ${dayLabel(day)} (${day})${when}: ${target}, measured ${formatHours(dayHours(input.measured, day))}h`
    })
    .join('\n')
}

function measuredTable(input: WorklogPromptInput): string {
  const { measured, days } = input
  const rows = measured.tasks
    .map((task) => {
      const cells = days.map((day) => measured.byTaskDay.get(task.taskId)?.get(day) ?? 0)
      return { task, cells, total: cells.reduce((sum, hours) => sum + hours, 0) }
    })
    .filter((row) => row.total > 0)
  if (rows.length === 0) return 'Nothing was measured in this period.'
  const header = `| Task | Title | ${days.map((day) => day.slice(5)).join(' | ')} | Total |`
  const rule = `|${' --- |'.repeat(days.length + 3)}`
  const body = rows.map(
    ({ task, cells, total }) =>
      `| ${task.taskId} | ${cell(task.title)} | ${cells
        .map((hours) => (hours ? formatHours(hours) : ''))
        .join(' | ')} | ${formatHours(total)} |`
  )
  return [header, rule, ...body].join('\n')
}

function taskSections(input: WorklogPromptInput): string {
  const first = input.days[0] ?? ''
  const last = input.days[input.days.length - 1] ?? ''
  const inPeriod = (at: string): boolean => {
    const day = localDay(at)
    return day >= first && day <= last
  }
  const measuredIds = new Set(input.measured.tasks.map((task) => task.taskId))
  const sections = input.tasks
    .filter((task) => measuredIds.has(task.id) || task.activity.some((entry) => inPeriod(entry.at)))
    .map((task) => {
      const notes = task.activity.filter((entry) => inPeriod(entry.at)).slice(-NOTES_PER_TASK)
      const meta = [
        task.project ? `Project: ${task.project}` : '',
        `Status: ${TASK_STATUS_LABELS[task.status]}`,
        task.tags.length ? `Tags: ${task.tags.join(', ')}` : ''
      ].filter(Boolean)
      return [
        `### ${task.id} — ${task.title}`,
        meta.join(' · '),
        ...(notes.length
          ? [
              'Notes in this period:',
              ...notes.map(
                (entry) =>
                  `- ${localDay(entry.at)} ${entry.author}: ${cell(entry.message).slice(0, NOTE_LENGTH)}`
              )
            ]
          : [])
      ].join('\n')
    })
  return sections.length ? sections.join('\n\n') : 'No task was worked on in this period.'
}

function localDay(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The prompt for one Suggest hours run: the template with every placeholder filled. */
export function worklogPrompt(template: string, input: WorklogPromptInput): string {
  const values: Record<string, () => string> = {
    period: () => input.period,
    timesheet: () => timesheetLines(input.timesheet),
    days: () => dayLines(input),
    measured: () => measuredTable(input),
    tasks: () => taskSections(input),
    rounding: () =>
      input.timesheet.roundMinutes
        ? `${input.timesheet.roundMinutes} minutes (${formatHours(input.timesheet.roundMinutes / 60)}h)`
        : 'two decimal places'
  }
  return (template.trim() || DEFAULT_WORKLOG_PROMPT).replace(
    /\{\{\s*(\w+)\s*\}\}/g,
    (match, name: string) => values[name]?.() ?? match
  )
}
