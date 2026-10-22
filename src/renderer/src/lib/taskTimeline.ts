import { AGENT_PROVIDER_SHORT_LABELS, type ActivityEntry, type Task } from '@core/types.js'

/** A row of a task's timeline: a note from its `## Activity`, or an event read off its fields. */
export interface TimelineEntry extends ActivityEntry {
  /** Derived from the task's frontmatter, never written: shown quieter than a note. */
  event: boolean
}

type TimelineTask = Pick<Task, 'activity' | 'sessions' | 'createdAt' | 'doneAt' | 'archivedAt'>

function time(iso: string | undefined): number {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isFinite(ms) ? ms : NaN
}

/**
 * The task's activity with the events its file already records — created, each agent run, done,
 * archived — merged in by time, oldest first. Nothing here is stored: the events come from the
 * frontmatter, so they need no write and cover every existing task. A note with no time (a bullet
 * typed by hand) keeps its place after the note before it; one that opens the log goes just before
 * the first timed note, or, when no note has a time, after the latest agent run started (an agent
 * wrote it), else after the task was created.
 */
export function taskTimeline(task: TimelineTask): TimelineEntry[] {
  const events: TimelineEntry[] = [
    { at: task.createdAt, author: 'styr', message: 'Task created', event: true },
    ...task.sessions.map((session) => ({
      at: session.startedAt,
      author: AGENT_PROVIDER_SHORT_LABELS[session.provider],
      message: `Started: ${session.label}`,
      event: true
    })),
    ...(task.doneAt
      ? [{ at: task.doneAt, author: 'styr', message: 'Moved to Done', event: true }]
      : []),
    ...(task.archivedAt
      ? [{ at: task.archivedAt, author: 'styr', message: 'Archived', event: true }]
      : [])
  ].filter((entry) => Number.isFinite(time(entry.at)))

  // Where the opening untimed notes sit: before the first timed note, else after the latest run
  // started (or creation). Math.max of nothing is -Infinity: the very start.
  const starts = [task.createdAt, ...task.sessions.map((session) => session.startedAt)]
  let carried =
    task.activity.map((entry) => time(entry.at)).find(Number.isFinite) ??
    Math.max(...starts.map(time).filter(Number.isFinite))
  const notes = task.activity.map((entry) => {
    const at = time(entry.at)
    if (Number.isFinite(at)) carried = at
    return { entry: { ...entry, event: false }, key: carried }
  })
  const keyed = [...events.map((entry) => ({ entry, key: time(entry.at) })), ...notes]
  // Stable, and an event before a note at the same moment: "Task created" heads the list.
  return keyed
    .map((item, index) => ({ ...item, index: item.entry.event ? index - keyed.length : index }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map((item) => item.entry)
}

/** The timeline's dot: hollow for a derived event, filled by who wrote a note. */
export function dotTone(entry: TimelineEntry): string {
  if (entry.event) return 'border border-dim'
  if (entry.author === 'you' || !entry.author) return 'bg-dim'
  return entry.author === 'subagent' ? 'bg-col-done' : 'bg-col-progress'
}
