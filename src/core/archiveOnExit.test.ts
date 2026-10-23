import { describe, expect, it } from 'vitest'
import { shouldArchiveOnExit } from './archiveOnExit.js'
import { PLAN_RUN_TAG } from './planning.js'
import type { Task } from './types.js'

const task = (extra: Partial<Task> = {}) =>
  ({ tags: ['ask'], status: 'in_progress', ...extra }) as Pick<
    Task,
    'tags' | 'status' | 'archivedAt'
  >
const on = { autoArchiveAsk: true }

describe('shouldArchiveOnExit', () => {
  it('archives an in-progress ask', () => {
    expect(shouldArchiveOnExit(task(), on)).toBe(true)
  })

  it.each(['backlog', 'in_review', 'done'] as const)('keeps an ask moved to %s', (status) => {
    expect(shouldArchiveOnExit(task({ status }), on)).toBe(false)
  })

  it('keeps an ask whose tag was removed', () => {
    expect(shouldArchiveOnExit(task({ tags: [] }), on)).toBe(false)
  })

  it('leaves an already archived task alone', () => {
    expect(shouldArchiveOnExit(task({ archivedAt: '2026-01-01T00:00:00Z' }), on)).toBe(false)
  })

  it('keeps asks when the setting is off', () => {
    expect(shouldArchiveOnExit(task(), { autoArchiveAsk: false })).toBe(false)
  })

  it('archives a planning run whatever its status or the setting', () => {
    const run = task({ tags: [PLAN_RUN_TAG], status: 'done' })
    expect(shouldArchiveOnExit(run, { autoArchiveAsk: false })).toBe(true)
  })
})
