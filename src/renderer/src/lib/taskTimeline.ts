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
 * typed by hand) keeps its place after the note before it.
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

  // An untimed note sorts with the note before it, or at the start when none before it has a time.
  let carried = -Infinity
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
