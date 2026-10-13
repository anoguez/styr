import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMESHEET, type Task } from './types.js'
import { measuredHours } from './worklog.js'
import { DEFAULT_WORKLOG_PROMPT, worklogPrompt, type WorklogPromptInput } from './worklogPrompt.js'

const at = (day: number, hour: number): number => new Date(2026, 9, day, hour).getTime()

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `Title ${id}`,
    status: 'done',
    tags: [],
    activity: [],
    ...extra
  } as unknown as Task
}

const input: WorklogPromptInput = {
  period: 'This week (Oct 12 – Oct 18, 2026)',
  days: ['2026-10-12', '2026-10-13', '2026-10-14'],
  today: '2026-10-13',
  timesheet: DEFAULT_TIMESHEET,
  measured: measuredHours([
    { taskId: 'TASK-1', title: 'Index | rebuild', intervals: [[at(12, 9), at(12, 12)]] }
  ]),
  tasks: [
    task('TASK-1', { title: 'Index | rebuild', project: 'styr' }),
    task('TASK-2', {
      activity: [{ at: new Date(at(13, 10)).toISOString(), author: 'claude', message: 'Fixed\nit' }]
    }),
    task('TASK-3')
  ]
}

describe('worklogPrompt', () => {
  const prompt = worklogPrompt('', input)

  it('uses the shipped template when the setting is empty, with every placeholder filled', () => {
    expect(prompt).toContain('This week (Oct 12 – Oct 18, 2026)')
    expect(prompt).not.toMatch(/\{\{\w+\}\}/)
    expect(prompt).toContain('suggest_worklog')
    expect(prompt).toContain('15 minutes (0.25h)')
  })

  it('describes each day: target, measured, today and the days still to come', () => {
    expect(prompt).toContain('- Mon Oct 12 (2026-10-12): working day, target 8.0h, measured 3.0h')
    expect(prompt).toContain('(2026-10-13) (today)')
    expect(prompt).toContain('(2026-10-14) (still to come)')
  })

  it('tables the measured hours and escapes cells', () => {
    expect(prompt).toContain('| TASK-1 | Index \\| rebuild | 3.0 |  |  | 3.0 |')
  })

  it('describes tasks measured or noted in the period, and leaves the rest out', () => {
    expect(prompt).toContain('### TASK-1 — Index | rebuild')
    expect(prompt).toContain('Project: styr · Status: Done')
    expect(prompt).toContain('- 2026-10-13 claude: Fixed it')
    expect(prompt).not.toContain('TASK-3')
  })

  it('fills a custom template and leaves unknown placeholders alone', () => {
    expect(worklogPrompt('{{period}} / {{unknown}}', input)).toBe(
      'This week (Oct 12 – Oct 18, 2026) / {{unknown}}'
    )
  })

  it('ships a template that names every placeholder it fills', () => {
    for (const name of ['period', 'timesheet', 'days', 'measured', 'tasks', 'rounding']) {
      expect(DEFAULT_WORKLOG_PROMPT).toContain(`{{${name}}}`)
    }
  })
})
