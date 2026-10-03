import { describe, expect, it } from 'vitest'
import { applyDoneCap } from './doneCap.js'
import type { Task } from './types.js'

const NOW = Date.parse('2026-10-03T00:00:00Z')

function done(id: string, daysAgo: number, order = 0): Task {
  const at = new Date(NOW - daysAgo * 86_400_000).toISOString()
  return { id, order, doneAt: at, updatedAt: NOW.toString() } as unknown as Task
}

const ids = (tasks: Task[]): string[] => tasks.map((task) => task.id)

describe('applyDoneCap', () => {
  it('hides everything over the count, keeping the most recently finished', () => {
    const tasks = [done('a', 5, 0), done('b', 1, 1), done('c', 3, 2)]
    const { visible, hidden } = applyDoneCap(tasks, { maxCount: 2, maxAgeDays: 0 }, NOW)
    expect(ids(visible)).toEqual(['b', 'c'])
    expect(ids(hidden)).toEqual(['a'])
  })

  it('hides tasks older than the age limit', () => {
    const tasks = [done('a', 20), done('b', 2)]
    const { visible, hidden } = applyDoneCap(tasks, { maxCount: 0, maxAgeDays: 14 }, NOW)
    expect(ids(visible)).toEqual(['b'])
    expect(ids(hidden)).toEqual(['a'])
  })

  it('shows everything when both limits are off', () => {
    const tasks = [done('a', 400), done('b', 1), done('c', 90)]
    expect(applyDoneCap(tasks, { maxCount: 0, maxAgeDays: 0 }, NOW).hidden).toEqual([])
  })

  it('falls back to updatedAt when a task has no doneAt', () => {
    const task = { id: 'x', order: 0, updatedAt: new Date(NOW - 30 * 86_400_000).toISOString() }
    const { hidden } = applyDoneCap([task as Task], { maxCount: 0, maxAgeDays: 7 }, NOW)
    expect(ids(hidden)).toEqual(['x'])
  })

  it('keeps board order among visible tasks', () => {
    const tasks = [done('a', 3, 0), done('b', 1, 1)]
    expect(ids(applyDoneCap(tasks, { maxCount: 5, maxAgeDays: 0 }, NOW).visible)).toEqual([
      'a',
      'b'
    ])
  })
})
