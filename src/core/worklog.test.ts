import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMESHEET, type TimesheetSettings, type WorklogTask } from './types.js'
import {
  buildWorklog,
  clipIntervals,
  dayKey,
  formatHours,
  formatTable,
  hoursByTaskDay,
  IDLE_GAP_MS,
  LEAD_MS,
  roundHours,
  timesheetTable,
  weekStartOf,
  workIntervals,
  worklogFrame
} from './worklog.js'

const MIN = 60_000
const HOUR = 60 * MIN
/** Local time, so day boundaries hold whatever zone the tests run in. */
const at = (day: number, hour: number, minute = 0, month = 9): number =>
  new Date(2026, month, day, hour, minute).getTime()
// Tuesday 13 October 2026, mid-afternoon.
const NOW = at(13, 15)
const exact: TimesheetSettings = { ...DEFAULT_TIMESHEET, roundMinutes: 0 }

function task(taskId: string, intervals: [number, number][], project?: string): WorklogTask {
  return { taskId, title: `Title ${taskId}`, project, intervals }
}

describe('workIntervals', () => {
  it('joins signals within the idle gap and opens each stretch with a lead', () => {
    const start = at(13, 9)
    const times = [start, start + 10 * MIN, start + 25 * MIN, start + 25 * MIN + IDLE_GAP_MS + 1]
    expect(workIntervals(times)).toEqual([
      [start - LEAD_MS, start + 25 * MIN],
      [times[3]! - LEAD_MS, times[3]!]
    ])
  })

  it('sorts its input and ignores unparseable times', () => {
    expect(workIntervals([at(13, 10), NaN, at(13, 9, 50)])).toEqual([
      [at(13, 9, 50) - LEAD_MS, at(13, 10)]
    ])
  })
})

describe('clipIntervals', () => {
  it('cuts to the span and drops what falls outside', () => {
    expect(
      clipIntervals(
        [
          [0, 10],
          [15, 30],
          [40, 50]
        ],
        5,
        40
      )
    ).toEqual([
      [5, 10],
      [15, 30]
    ])
  })
})

describe('hoursByTaskDay', () => {
  it('shares time two tasks were worked on at once', () => {
    const hours = hoursByTaskDay([
      task('A', [[at(13, 9), at(13, 11)]]),
      task('B', [[at(13, 10), at(13, 12)]])
    ])
    expect(hours.get('A')?.get('2026-10-13')).toBeCloseTo(1.5)
    expect(hours.get('B')?.get('2026-10-13')).toBeCloseTo(1.5)
  })

  it('splits a stretch across midnight into both days', () => {
    const hours = hoursByTaskDay([task('A', [[at(12, 23), at(13, 1)]])])
    expect(hours.get('A')?.get('2026-10-12')).toBeCloseTo(1)
    expect(hours.get('A')?.get('2026-10-13')).toBeCloseTo(1)
  })
})

describe('roundHours and formatHours', () => {
  it('rounds to the nearest step, or not at all', () => {
    expect(roundHours(1.1, 15)).toBe(1)
    expect(roundHours(1.15, 15)).toBe(1.25)
    expect(roundHours(0.2, 30)).toBe(0)
    expect(roundHours(1.1, 0)).toBe(1.1)
  })

  it('keeps a whole hour’s .0 and at most two decimals', () => {
    expect(formatHours(8)).toBe('8.0')
    expect(formatHours(7.75)).toBe('7.75')
    expect(formatHours(1 / 3)).toBe('0.33')
  })
})

describe('worklogFrame', () => {
  it('lays out this week from its first day', () => {
    const frame = worklogFrame('week', 0, NOW, 'mon')
    expect(frame.title).toBe('This week')
    expect(frame.range).toBe('Oct 12 – Oct 18, 2026')
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

  it('starts the week on Sunday when asked', () => {
    expect(weekStartOf('2026-10-13', 'sun')).toBe('2026-10-11')
    expect(worklogFrame('week', 1, NOW, 'sun').title).toBe('Last week')
  })

  it('charts the week around the day it shows, and fetches all of it', () => {
    const frame = worklogFrame('day', 1, NOW, 'mon')
    expect(frame.title).toBe('Yesterday')
    expect(frame.range).toBe('Mon, Oct 12, 2026')
    expect(frame.selectedDay).toBe('2026-10-12')
    expect(frame.buckets).toHaveLength(1)
    expect(frame.chart).toHaveLength(7)
    expect(frame.to - frame.from).toBeGreaterThan(6 * 24 * HOUR)
  })

  it('groups a month into its weeks', () => {
    const frame = worklogFrame('month', 1, NOW, 'mon')
    expect(frame.title).toBe('September 2026')
    expect(frame.range).toBe('Sep 1 – Sep 30')
    expect(frame.buckets[0]).toMatchObject({ label: 'Sep 1', sub: '– 6' })
    expect(frame.buckets.flatMap((bucket) => bucket.days)).toHaveLength(30)
  })
})

describe('buildWorklog', () => {
  const tasks = [
    task('TASK-1', [[at(12, 9), at(12, 15)]], 'styr'),
    task('TASK-2', [[at(13, 9), at(13, 11)]], 'styr'),
    task('TASK-3', [[at(13, 13), at(13, 14)]])
  ]
  const frame = worklogFrame('week', 0, NOW, 'mon')

  it('totals rows, buckets and projects against the target', () => {
    const worklog = buildWorklog(frame, tasks, exact, NOW)
    expect(worklog.rows.map((row) => [row.taskId, row.total])).toEqual([
      ['TASK-1', 6],
      ['TASK-2', 2],
      ['TASK-3', 1]
    ])
    expect(worklog.buckets[0]).toMatchObject({ total: 6, target: 8, future: false })
    expect(worklog.buckets[1]).toMatchObject({ total: 3, hasToday: true })
    expect(worklog.buckets[5]).toMatchObject({ target: 0, future: true })
    expect(worklog.groups.map((group) => [group.project, group.total])).toEqual([
      ['styr', 8],
      ['No project', 1]
    ])
    expect(worklog).toMatchObject({ logged: 9, target: 40, left: 31, current: true, todayLeft: 5 })
  })

  it('lists past working days short of a full day', () => {
    const worklog = buildWorklog(frame, tasks, exact, NOW)
    expect(worklog.gaps).toEqual([{ day: '2026-10-12', short: 2 }])
  })

  it('rounds each task’s day before totalling', () => {
    const odd = [task('A', [[at(13, 9), at(13, 9, 10)]]), task('B', [[at(13, 10), at(13, 10, 50)]])]
    const worklog = buildWorklog(frame, odd, { ...exact, roundMinutes: 30 }, NOW)
    expect(worklog.rows.map((row) => row.total)).toEqual([1])
    expect(worklog.logged).toBe(1)
  })

  it('sets no target on days that are not working days', () => {
    const worklog = buildWorklog(
      frame,
      [],
      { ...exact, workingDays: [true, false, false, false, false, false, false] },
      NOW
    )
    expect(worklog.target).toBe(8)
    expect(worklog.todayLeft).toBe(0)
  })
})

describe('timesheetTable and formatTable', () => {
  const worklog = buildWorklog(
    worklogFrame('week', 0, NOW, 'mon'),
    [
      task('TASK-1', [[at(12, 9), at(12, 11)]], 'styr'),
      task('TASK-2', [[at(13, 9), at(13, 10)]], 'a, b')
    ],
    exact,
    NOW
  )

  it('lays out a header, a line per task and the Logged line', () => {
    const rows = timesheetTable(worklog, 'task')
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
      'Total'
    ])
    expect(rows[1]).toEqual([
      'TASK-1',
      'Title TASK-1',
      'styr',
      '2.0',
      '',
      '',
      '',
      '',
      '',
      '',
      '2.0'
    ])
    expect(rows[rows.length - 1]).toEqual([
      '',
      'Logged',
      '',
      '2.0',
      '1.0',
      '0.0',
      '0.0',
      '0.0',
      '0.0',
      '0.0',
      '3.0'
    ])
  })

  it('heads each project with its total when grouped by project', () => {
    const rows = timesheetTable(worklog, 'project')
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
