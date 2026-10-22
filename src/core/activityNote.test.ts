import { describe, expect, it } from 'vitest'
import { NOTE_BULLET } from './activityNote.js'
import { parseTaskMarkdown } from './markdown.js'

describe('NOTE_BULLET', () => {
  it('reads back with its time and author when an agent follows it by hand', () => {
    const shape = NOTE_BULLET.slice(3, -3) // drop the outer double-backtick code span
    const bullet = shape
      .replace('<ISO 8601 time>', '2026-10-22T09:00:00.000Z')
      .replace('<your name>', 'claude')
      .replace('<note>', 'Tests pass.')
    const task = parseTaskMarkdown(
      [
        '---',
        'id: TASK-0001',
        'title: A task',
        'status: in_progress',
        "createdAt: '2026-10-22T08:00:00.000Z'",
        "updatedAt: '2026-10-22T08:00:00.000Z'",
        '---',
        'Body.',
        '',
        '## Activity',
        '',
        bullet,
        ''
      ].join('\n'),
      '/tmp/TASK-0001-a-task.md'
    )
    expect(task.activity).toEqual([
      { at: '2026-10-22T09:00:00.000Z', author: 'claude', message: 'Tests pass.' }
    ])
  })
})
