import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { newestCodexSessionFor } from './codex.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('newestCodexSessionFor', () => {
  it('returns the newest session started in the task working directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'styr-codex-sessions-test-'))
    directories.push(root)
    const sessions = join(root, '.codex', 'sessions', '2026', '10', '01')
    mkdirSync(sessions, { recursive: true })
    const taskDirectory = '/workspace/styr.worktrees/TASK-0007'

    writeFileSync(
      join(sessions, 'other.jsonl'),
      `${JSON.stringify({ type: 'session_meta', timestamp: '2026-10-01T12:00:00.000Z', payload: { id: 'other', cwd: '/workspace/other' } })}\n`
    )
    writeFileSync(
      join(sessions, 'older.jsonl'),
      `${JSON.stringify({ type: 'session_meta', timestamp: '2026-10-01T12:01:00.000Z', payload: { id: 'older', cwd: taskDirectory } })}\n`
    )
    writeFileSync(
      join(sessions, 'newest.jsonl'),
      `${JSON.stringify({ type: 'session_meta', timestamp: '2026-10-01T12:02:00.000Z', payload: { id: 'newest', cwd: taskDirectory } })}\n`
    )

    expect(newestCodexSessionFor(taskDirectory, '2026-10-01T12:00:30.000Z', root)).toBe('newest')
  })
})
