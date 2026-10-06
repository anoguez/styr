import { describe, expect, it } from 'vitest'
import { openTaskCounts } from './boardCounts.js'
import type { Task, TaskStatus } from './types.js'

const t = (readiness?: string): Task => ({ readiness }) as unknown as Task
const board = (o: Partial<Record<TaskStatus, Task[]>>): Record<TaskStatus, Task[]> => ({
  backlog: [],
  in_progress: [],
  in_review: [],
  done: [],
  ...o
})

describe('openTaskCounts', () => {
  it('leaves Done out of the total', () => {
    const out = openTaskCounts(
      board({
        backlog: [t(), t(), t()],
        in_progress: [t(), t()],
        in_review: [t()],
        done: [t(), t(), t(), t(), t()]
      })
    )
    expect(out.total).toBe(6)
  })

  it('is zero when only Done tasks exist, and for an empty board', () => {
    expect(openTaskCounts(board({ done: [t()] })).total).toBe(0)
    expect(openTaskCounts(board({})).total).toBe(0)
  })

  it('does not count a Done task that needs a spec', () => {
    const out = openTaskCounts(board({ backlog: [t('needs_spec')], done: [t('needs_spec')] }))
    expect(out.needsSpec).toBe(1)
  })
})
