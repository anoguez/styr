import { describe, expect, it } from 'vitest'
import { sortColumn } from './boardOrder.js'
import type { Task, TaskPriority } from './types.js'

function task(id: string, priority: TaskPriority, order = 0): Task {
  return { id, priority, order, createdAt: '2026-01-01T00:00:00Z' } as unknown as Task
}
const ids = (tasks: Task[]): string[] => tasks.map((t) => t.id)

describe('sortColumn', () => {
  it('puts higher priority first', () => {
    const out = sortColumn(
      [task('a', 'low'), task('b', 'urgent'), task('c', 'medium')],
      () => undefined
    )
    expect(ids(out)).toEqual(['b', 'c', 'a'])
  })

  it('lifts working tasks within a priority, but not above a higher priority', () => {
    const out = sortColumn(
      [task('a', 'medium', 0), task('b', 'medium', 1), task('c', 'high', 2)],
      (id) => (id === 'b' ? 'working' : 'idle')
    )
    expect(ids(out)).toEqual(['c', 'b', 'a'])
  })

  it('falls back to manual order', () => {
    const out = sortColumn([task('a', 'medium', 2), task('b', 'medium', 1)], () => undefined)
    expect(ids(out)).toEqual(['b', 'a'])
  })
})
