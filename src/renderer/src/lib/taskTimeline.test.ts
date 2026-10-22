import { describe, expect, it } from 'vitest'
import { taskTimeline } from './taskTimeline.js'

const base = {
  createdAt: '2026-10-20T10:00:00.000Z',
  sessions: [],
  activity: []
}

describe('taskTimeline', () => {
  it('heads a new task with its creation', () => {
    expect(taskTimeline(base)).toEqual([
      { at: base.createdAt, author: 'styr', message: 'Task created', event: true }
    ])
  })

  it('merges agent runs, done and archived with the notes by time', () => {
    const rows = taskTimeline({
      ...base,
      sessions: [
        {
          id: 's1',
          provider: 'claude',
          startedAt: '2026-10-20T11:00:00.000Z',
          label: 'Implement the task'
        }
      ],
      activity: [
        { at: '2026-10-20T12:00:00.000Z', author: 'claude', message: 'Tests pass.' },
        { at: '2026-10-20T10:30:00.000Z', author: 'you', message: 'Clarified the scope.' }
      ],
      doneAt: '2026-10-20T13:00:00.000Z',
      archivedAt: '2026-10-21T09:00:00.000Z'
    })
    expect(rows.map((row) => `${row.author}: ${row.message}`)).toEqual([
      'styr: Task created',
      'you: Clarified the scope.',
      'Claude: Started: Implement the task',
      'claude: Tests pass.',
      'styr: Moved to Done',
      'styr: Archived'
    ])
  })

  it('keeps an untimed note after the note before it', () => {
    const rows = taskTimeline({
      ...base,
      sessions: [
        { id: 's1', provider: 'codex', startedAt: '2026-10-20T12:30:00.000Z', label: 'Review' }
      ],
      activity: [
        { at: '', author: '', message: 'Typed by hand first.' },
        { at: '2026-10-20T12:00:00.000Z', author: 'claude', message: 'Timed.' },
        { at: '', author: '', message: 'Typed by hand after.' }
      ]
    })
    expect(rows.map((row) => row.message)).toEqual([
      'Typed by hand first.',
      'Task created',
      'Timed.',
      'Typed by hand after.',
      'Started: Review'
    ])
  })

  it('drops an event whose time does not parse', () => {
    expect(taskTimeline({ ...base, createdAt: 'garbage' })).toEqual([])
  })
})
