import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TranscriptUsage } from './providers/types.js'
import type { Task } from './types.js'
import { collectWorklog, transcriptSources, type WorklogSourcePorts } from './worklogSources.js'

/** Local time, so day boundaries hold whatever zone the tests run in. */
const at = (day: number, hour: number): number => new Date(2026, 9, day, hour).getTime()
const FROM = at(12, 0)
const TO = at(19, 0)

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    status: 'in_progress',
    tags: [],
    activity: [],
    sessions: [],
    updatedAt: '2026-10-13T00:00:00Z',
    ...extra
  } as unknown as Task
}

const session = (id: string, startedAt = '') => ({
  id,
  provider: 'claude' as const,
  startedAt,
  label: ''
})

function ports(transcripts: Record<string, TranscriptUsage[]>): WorklogSourcePorts {
  return { sessionUsage: (_provider, id) => transcripts[id] }
}

describe('collectWorklog', () => {
  it('sums each session’s tokens per day within the span', () => {
    const [worked] = collectWorklog(
      [task('TASK-1', { project: 'styr', sessions: [session('s1')] })],
      FROM,
      TO,
      ports({
        s1: [
          { at: at(11, 23), tokens: 999 },
          { at: at(13, 9), tokens: 100 },
          { at: at(13, 10), tokens: 50 },
          { at: at(14, 9), tokens: 7 }
        ]
      })
    )
    expect(worked).toEqual({
      taskId: 'TASK-1',
      title: 'TASK-1',
      project: 'styr',
      sessions: [
        { day: '2026-10-13', sessionId: 's1', tokens: 150 },
        { day: '2026-10-14', sessionId: 's1', tokens: 7 }
      ]
    })
  })

  it('counts a session whose transcript is gone on the day it started', () => {
    const started = new Date(at(15, 9)).toISOString()
    const [worked] = collectWorklog(
      [task('TASK-1', { sessions: [session('gone', started)] })],
      FROM,
      TO,
      ports({})
    )
    expect(worked!.sessions).toEqual([{ day: '2026-10-15', sessionId: 'gone', tokens: 0 }])
  })

  it('does not count a forked message twice', () => {
    const [worked] = collectWorklog(
      [task('TASK-1', { sessions: [session('parent'), session('fork')] })],
      FROM,
      TO,
      ports({
        parent: [{ at: at(13, 9), tokens: 100, id: 'm1' }],
        fork: [
          { at: at(13, 9), tokens: 100, id: 'm1' },
          { at: at(14, 9), tokens: 30, id: 'm2' }
        ]
      })
    )
    expect(worked!.sessions).toEqual([
      { day: '2026-10-13', sessionId: 'parent', tokens: 100 },
      { day: '2026-10-14', sessionId: 'fork', tokens: 30 }
    ])
  })

  it('drops tasks with no session in the span, and skips tasks Done before it', () => {
    let asked = 0
    const counting: WorklogSourcePorts = {
      sessionUsage: () => {
        asked++
        return []
      }
    }
    const done = task('TASK-2', {
      status: 'done',
      updatedAt: '2026-10-01T00:00:00Z',
      sessions: [session('s')]
    })
    expect(
      collectWorklog([task('TASK-1', { sessions: [session('s')] }), done], FROM, TO, counting)
    ).toEqual([])
    expect(asked).toBe(1)
  })
})

describe('transcriptSources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'styr-worklog-'))
  const file = join(dir, 's1.jsonl')
  const line = (at: number, tokens: number): string => `${JSON.stringify({ at, tokens })}\n`

  /** A provider whose transcript is `file`, counting lookups and the text it is handed. */
  function fake() {
    const seen = { lookups: 0, parsed: [] as string[] }
    const ports = transcriptSources(() => ({
      transcriptPath: (id) => {
        seen.lookups++
        return id === 's1' ? file : undefined
      },
      transcriptUsageReader: () => (text) => {
        seen.parsed.push(text)
        return text
          .split('\n')
          .filter(Boolean)
          .map((json) => JSON.parse(json) as TranscriptUsage)
      }
    }))
    return { seen, usage: () => ports.sessionUsage('claude', 's1') }
  }

  it('finds a transcript once and reads only the lines added since', () => {
    writeFileSync(file, line(1, 10))
    const { seen, usage } = fake()
    expect(usage()).toEqual([{ at: 1, tokens: 10 }])
    expect(usage()).toEqual([{ at: 1, tokens: 10 }])
    appendFileSync(file, line(2, 20))
    expect(usage()).toEqual([
      { at: 1, tokens: 10 },
      { at: 2, tokens: 20 }
    ])
    expect(seen.lookups).toBe(1)
    expect(seen.parsed).toEqual([line(1, 10), line(2, 20)])
  })

  it('leaves a line being written for the next read', () => {
    writeFileSync(file, line(1, 10) + '{"at":2,')
    const { seen, usage } = fake()
    expect(usage()).toEqual([{ at: 1, tokens: 10 }])
    appendFileSync(file, '"tokens":20}\n')
    expect(usage()).toHaveLength(2)
    expect(seen.parsed[1]).toBe(line(2, 20))
  })

  it('reads a rewritten transcript again, and looks a vanished one up again', () => {
    writeFileSync(file, line(1, 10) + line(2, 20))
    const { seen, usage } = fake()
    usage()
    writeFileSync(file, line(3, 30))
    expect(usage()).toEqual([{ at: 3, tokens: 30 }])
    rmSync(file)
    expect(usage()).toBeUndefined()
    expect(seen.lookups).toBe(2)
  })
})
