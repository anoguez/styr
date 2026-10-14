import { describe, expect, it } from 'vitest'
import type { WorklogSessionDay, WorklogTask } from './types.js'
import {
  buildWorklog,
  dayKey,
  formatTable,
  formatTokens,
  weekStartOf,
  worklogFrame,
  worklogTable
} from './worklog.js'

const HOUR = 3_600_000
/** Local time, so day boundaries hold whatever zone the tests run in. */
const at = (day: number, hour: number, minute = 0, month = 9): number =>
  new Date(2026, month, day, hour, minute).getTime()
// Tuesday 13 October 2026, mid-afternoon.
const NOW = at(13, 15)

function task(taskId: string, sessions: WorklogSessionDay[], project?: string): WorklogTask {
  return { taskId, title: `Title ${taskId}`, project, sessions }
}

describe('worklogFrame', () => {
  it('lays out this week from its Monday', () => {
    const frame = worklogFrame('week', 0, NOW)
    expect(frame.title).toBe('This week')
    expect(frame.range).toBe('Oct 12 – Oct 18, 2026')
    expect(frame.chartTitle).toBe('Tokens per day')
    expect(frame.buckets.map((bucket) => `${bucket.label} ${bucket.sub}`)).toEqual([
      'Mon 12',
      'Tue 13',
      'Wed 14',
      'Thu 15',
      'Fri 16',
      'Sat 17',
      'Sun 18'
    ])
    expect(frame.from).toBe(at(12, 0))
    expect(frame.to).toBe(at(19, 0))
  })

  it('starts weeks on Monday', () => {
    expect(weekStartOf('2026-10-13')).toBe('2026-10-12')
    expect(weekStartOf('2026-10-18')).toBe('2026-10-12')
    expect(worklogFrame('week', 1, NOW).title).toBe('Last week')
  })

  it('charts the week around the day it shows, and fetches all of it', () => {
    const frame = worklogFrame('day', 1, NOW)
    expect(frame.title).toBe('Yesterday')
    expect(frame.range).toBe('Mon, Oct 12, 2026')
    expect(frame.selectedDay).toBe('2026-10-12')
    expect(frame.buckets).toHaveLength(1)
    expect(frame.chart).toHaveLength(7)
    expect(frame.to - frame.from).toBeGreaterThan(6 * 24 * HOUR)
  })

  it('groups a month into its weeks', () => {
    const frame = worklogFrame('month', 1, NOW)
    expect(frame.title).toBe('September 2026')
    expect(frame.range).toBe('Sep 1 – Sep 30')
    expect(frame.chartTitle).toBe('Tokens per week')
    expect(frame.buckets[0]).toMatchObject({ label: 'Sep 1', sub: '– 6' })
    expect(frame.buckets.flatMap((bucket) => bucket.days)).toHaveLength(30)
  })
})

describe('buildWorklog', () => {
  const tasks = [
    task(
      'TASK-1',
      [
        { day: '2026-10-12', sessionId: 's1', tokens: 1000 },
        { day: '2026-10-13', sessionId: 's1', tokens: 500 },
        { day: '2026-10-13', sessionId: 's2', tokens: 250 }
      ],
      'styr'
    ),
    task('TASK-2', [{ day: '2026-10-13', sessionId: 's3', tokens: 4000 }], 'other'),
    // A session whose transcript is gone: counted, with no tokens.
    task('TASK-3', [{ day: '2026-10-14', sessionId: 's4', tokens: 0 }])
  ]
  const worklog = buildWorklog(worklogFrame('week', 0, NOW), tasks, NOW)

  it('totals tokens per row, bucket and project, most tokens first', () => {
    expect(worklog.rows.map((row) => [row.taskId, row.tokens, row.sessions])).toEqual([
      ['TASK-2', 4000, 1],
      ['TASK-1', 1750, 2],
      ['TASK-3', 0, 1]
    ])
    expect(worklog.rows[1]!.cells.slice(0, 3)).toEqual([1000, 750, 0])
    expect(worklog.groups.map((group) => [group.project, group.tokens])).toEqual([
      ['other', 4000],
      ['styr', 1750],
      ['No project', 0]
    ])
    expect(worklog.tokens).toBe(5750)
  })

  it('counts a session once per bucket and once per period, however many days it ran', () => {
    expect(worklog.sessions).toBe(4)
    expect(worklog.buckets.slice(0, 3).map((bucket) => bucket.sessions)).toEqual([1, 3, 1])
    const month = buildWorklog(worklogFrame('month', 0, NOW), tasks, NOW)
    expect(month.buckets.find((bucket) => bucket.days.includes('2026-10-12'))!.sessions).toBe(4)
  })

  it('names the busiest day and splits buckets by project', () => {
    expect(worklog.busiest).toEqual({ day: '2026-10-13', tokens: 4750 })
    expect(worklog.buckets[1]!.byProject).toEqual({ styr: 750, other: 4000 })
    expect(worklog.buckets[2]!.future).toBe(true)
    expect(worklog.buckets[1]!.hasToday).toBe(true)
  })

  it('leaves out sessions outside the period', () => {
    const lastWeek = buildWorklog(worklogFrame('week', 1, NOW), tasks, NOW)
    expect(lastWeek.rows).toEqual([])
    expect(lastWeek.busiest).toBeUndefined()
  })
})

describe('formatTokens', () => {
  it('shortens counts to k and M', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(850)).toBe('850')
    expect(formatTokens(12_340)).toBe('12.3k')
    expect(formatTokens(2000)).toBe('2k')
    expect(formatTokens(456_400)).toBe('456k')
    expect(formatTokens(999_700)).toBe('1M')
    expect(formatTokens(1_254_000)).toBe('1.25M')
    expect(formatTokens(12_500_000)).toBe('12.5M')
  })
})

describe('worklogTable and formatTable', () => {
  const worklog = buildWorklog(
    worklogFrame('week', 0, NOW),
    [
      task('TASK-1', [{ day: '2026-10-12', sessionId: 's1', tokens: 1200 }], 'styr'),
      task('TASK-2', [{ day: '2026-10-13', sessionId: 's2', tokens: 300 }], 'a, b')
    ],
    NOW
  )

  it('lays out a header, a line per task with exact counts, and the Total line', () => {
    const rows = worklogTable(worklog, 'task')
    expect(rows[0]).toEqual([
      'Task',
      'Title',
      'Project',
      'Mon 12',
      'Tue 13',
      'Wed 14',
      'Thu 15',
      'Fri 16',
      'Sat 17',
      'Sun 18',
      'Sessions',
      'Tokens'
    ])
    expect(rows[1]).toEqual([
      'TASK-1',
      'Title TASK-1',
      'styr',
      '1200',
      '',
      '',
      '',
      '',
      '',
      '',
      '1',
      '1200'
    ])
    expect(rows[rows.length - 1]).toEqual([
      '',
      'Total',
      '',
      '1200',
      '300',
      '0',
      '0',
      '0',
      '0',
      '0',
      '2',
      '1500'
    ])
  })

  it('heads each project with its total when grouped by project', () => {
    const rows = worklogTable(worklog, 'project')
    expect(rows.slice(1, 3).map((row) => row[0])).toEqual(['styr', '  TASK-1'])
  })

  it('quotes CSV cells that need it and keeps TSV on one line per row', () => {
    const rows = [['a, b', 'say "hi"', 'x\ty']]
    expect(formatTable(rows, 'csv')).toBe('"a, b","say ""hi""",x\ty')
    expect(formatTable(rows, 'tsv')).toBe('a, b\tsay "hi"\tx y')
  })
})

describe('dayKey', () => {
  it('names the local calendar day', () => {
    expect(dayKey(at(13, 0, 0))).toBe('2026-10-13')
    expect(dayKey(at(13, 23, 59))).toBe('2026-10-13')
  })
})
