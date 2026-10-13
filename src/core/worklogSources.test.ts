import { describe, expect, it } from 'vitest'
import type { Task } from './types.js'
import { LEAD_MS } from './worklog.js'
import { collectWorklog, transcriptTimes, type WorklogSourcePorts } from './worklogSources.js'

const MIN = 60_000
const FROM = Date.parse('2026-10-12T00:00:00Z')
const TO = Date.parse('2026-10-19T00:00:00Z')

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    status: 'in_progress',
    activity: [],
    sessions: [],
    updatedAt: '2026-10-13T00:00:00Z',
    ...extra
  } as unknown as Task
}

const noSources: WorklogSourcePorts = { sessionTimes: () => [], commitTimes: () => [] }

describe('collectWorklog', () => {
  it('merges transcript, note and commit times into one task’s stretches', () => {
    const start = Date.parse('2026-10-13T09:00:00Z')
    const ports: WorklogSourcePorts = {
      sessionTimes: (provider, id) =>
        provider === 'claude' && id === 's1' ? [start, start + 10 * MIN] : [],
      commitTimes: () => [start + 20 * MIN]
    }
    const [worked] = collectWorklog(
      [
        task('TASK-1', {
          project: 'styr',
          activity: [
            { at: new Date(start + 15 * MIN).toISOString(), author: 'claude', message: 'x' }
          ],
          sessions: [{ id: 's1', provider: 'claude', startedAt: '', label: '' }]
        })
      ],
      FROM,
      TO,
      ports
    )
    expect(worked).toEqual({
      taskId: 'TASK-1',
      title: 'TASK-1',
      project: 'styr',
      intervals: [[start - LEAD_MS, start + 20 * MIN]]
    })
  })

  it('drops tasks with no time in the span, and skips tasks Done before it', () => {
    let asked = 0
    const ports: WorklogSourcePorts = {
      sessionTimes: () => [],
      commitTimes: () => {
        asked++
        return [Date.parse('2026-10-01T09:00:00Z')]
      }
    }
    const done = task('OLD', { status: 'done', updatedAt: '2026-10-01T00:00:00Z' })
    expect(collectWorklog([task('IDLE'), done], FROM, TO, ports)).toEqual([])
    expect(asked).toBe(1)
  })

  it('cuts a stretch that crosses the span’s start', () => {
    const [worked] = collectWorklog(
      [task('A', { activity: [{ at: '2026-10-12T00:02:00Z', author: 'a', message: 'm' }] })],
      FROM,
      TO,
      noSources
    )
    expect(worked?.intervals).toEqual([[FROM, Date.parse('2026-10-12T00:02:00Z')]])
  })
})

describe('transcriptTimes', () => {
  it('reads the first timestamp on each line and skips lines without one', () => {
    const text = [
      '{"type":"mode"}',
      '{"timestamp":"2026-10-13T10:36:40.938Z","payload":{"timestamp":"2026-10-13T10:36:40.707Z"}}',
      '{"type":"user","timestamp":"2026-10-13T10:40:00Z"}',
      'not json'
    ].join('\n')
    expect(transcriptTimes(text)).toEqual([
      Date.parse('2026-10-13T10:36:40.938Z'),
      Date.parse('2026-10-13T10:40:00Z')
    ])
  })
})
