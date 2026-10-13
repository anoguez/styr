import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_ID, type Settings } from './types.js'
import { readWorklogSuggestions, worklogDir, writeWorklogSuggestions } from './worklogStore.js'

let root: string
let settings: Settings

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'styr-worklog-'))
  settings = { storageDir: root, activeWorkspaceId: DEFAULT_WORKSPACE_ID } as Settings
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const now = new Date('2026-10-13T12:00:00Z')

describe('worklogStore', () => {
  it('writes one file per day and reads back the days in a range', () => {
    writeWorklogSuggestions(
      settings,
      [
        { day: '2026-10-12', taskId: 'TASK-1', hours: 6, note: 'Index' },
        { day: '2026-10-12', taskId: 'TASK-2', hours: 2 },
        { day: '2026-10-13', taskId: 'TASK-1', hours: 8 }
      ],
      now
    )
    expect(readWorklogSuggestions(settings, '2026-10-12', '2026-10-12')).toEqual([
      {
        day: '2026-10-12',
        generatedAt: now.toISOString(),
        entries: [
          { taskId: 'TASK-1', hours: 6, note: 'Index' },
          { taskId: 'TASK-2', hours: 2 }
        ]
      }
    ])
    expect(readWorklogSuggestions(settings, '2026-10-01', '2026-10-31')).toHaveLength(2)
  })

  it('replaces a day whole and leaves the other days alone', () => {
    writeWorklogSuggestions(settings, [
      { day: '2026-10-12', taskId: 'TASK-1', hours: 6 },
      { day: '2026-10-13', taskId: 'TASK-1', hours: 8 }
    ])
    writeWorklogSuggestions(settings, [{ day: '2026-10-12', taskId: 'TASK-9', hours: 8 }])
    const days = readWorklogSuggestions(settings, '2026-10-12', '2026-10-13')
    expect(days.map((day) => day.entries.map((entry) => entry.taskId))).toEqual([
      ['TASK-9'],
      ['TASK-1']
    ])
  })

  it('refuses entries that are not a date and hours, and skips a broken file', () => {
    expect(() =>
      writeWorklogSuggestions(settings, [{ day: '13/10', taskId: 'TASK-1', hours: 2 }])
    ).toThrow()
    expect(() =>
      writeWorklogSuggestions(settings, [{ day: '2026-10-13', taskId: 'TASK-1', hours: 30 }])
    ).toThrow()
    writeWorklogSuggestions(settings, [{ day: '2026-10-14', taskId: 'TASK-1', hours: 1 }])
    writeFileSync(join(worklogDir(settings), '2026-10-15.json'), '{ nope')
    expect(readWorklogSuggestions(settings, '2026-10-14', '2026-10-15')).toHaveLength(1)
    expect(readFileSync(join(worklogDir(settings), '2026-10-14.json'), 'utf8')).toContain('TASK-1')
  })
})
