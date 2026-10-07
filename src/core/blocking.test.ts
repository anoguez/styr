import { describe, expect, it } from 'vitest'
import {
  blockerProblem,
  danglingBlockers,
  findCycle,
  indexTasks,
  openBlockers
} from './blocking.js'
import type { Task, TaskStatus } from './types.js'

type T = Pick<Task, 'id' | 'status' | 'blockedBy' | 'archivedAt'>
const t = (
  id: string,
  status: TaskStatus = 'backlog',
  blockedBy: string[] = [],
  archived = false
): T => ({
  id,
  status,
  blockedBy,
  archivedAt: archived ? '2026-01-01T00:00:00Z' : undefined
})
const ids = (tasks: { id: string }[]): string[] => tasks.map((task) => task.id)

describe('openBlockers', () => {
  it('lists blockers that are not Done and ignores finished ones', () => {
    const all = [t('A', 'backlog', ['B', 'C', 'D']), t('B', 'done'), t('C', 'in_progress'), t('D')]
    expect(ids(openBlockers(all[0]!, indexTasks(all)))).toEqual(['C', 'D'])
  })

  it('ignores unknown ids and reports them as dangling', () => {
    const task = t('A', 'backlog', ['X'])
    expect(openBlockers(task, indexTasks([task]))).toEqual([])
    expect(danglingBlockers(task, indexTasks([task]))).toEqual(['X'])
  })

  it('counts an archived blocker unless it is Done', () => {
    const all = [
      t('A', 'backlog', ['B', 'C']),
      t('B', 'backlog', [], true),
      t('C', 'done', [], true)
    ]
    expect(ids(openBlockers(all[0]!, indexTasks(all)))).toEqual(['B'])
  })

  it('never blocks a Done task, and keeps both ends of a cycle blocked without looping', () => {
    const a = t('A', 'done', ['B'])
    const b = t('B', 'backlog', ['C'])
    const c = t('C', 'backlog', ['B'])
    const byId = indexTasks([a, b, c])
    expect(openBlockers(a, byId)).toEqual([])
    expect(ids(openBlockers(b, byId))).toEqual(['C'])
    expect(ids(openBlockers(c, byId))).toEqual(['B'])
  })

  it('keeps a task blocked behind a blocker that is itself blocked', () => {
    const all = [t('A', 'backlog', ['B']), t('B', 'backlog', ['C']), t('C', 'in_progress')]
    expect(ids(openBlockers(all[0]!, indexTasks(all)))).toEqual(['B'])
  })
})

describe('findCycle', () => {
  const byId = indexTasks([t('A', 'backlog', ['B']), t('B', 'backlog', ['C']), t('C')])

  it('finds the path a new blocker would close', () => {
    expect(findCycle('C', ['A'], byId)).toEqual(['C', 'A', 'B', 'C'])
    expect(findCycle('A', ['C'], byId)).toBeNull()
  })

  it('treats self-reference as a cycle', () => {
    expect(findCycle('A', ['A'], byId)).toEqual(['A', 'A'])
  })
})

describe('blockerProblem', () => {
  const byId = indexTasks([t('A', 'backlog', ['B']), t('B')])

  it('explains why a list cannot be written', () => {
    expect(blockerProblem('B', ['A'], byId)).toBe(
      'Blocking would create a dependency cycle: B → A → B'
    )
    expect(blockerProblem('A', ['Z'], byId)).toBe('Unknown blocker Z')
    expect(blockerProblem('B', [], byId)).toBeNull()
  })
})
