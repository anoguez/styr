import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '@core/agentState.js'
import type { OrchestrationSummary, Task } from '@core/types.js'
import { boardTasks, dispatchQueue, sortBoard, taskSummaries, type Board } from './boardView.js'

const task = (id: string, overrides: Partial<Task> = {}): Task =>
  ({ id, title: `T ${id}`, status: 'backlog', priority: 'medium', ...overrides }) as Task

const board = (tasks: Partial<Board>): Board => ({
  backlog: [],
  in_progress: [],
  in_review: [],
  done: [],
  ...tasks
})

describe('sortBoard', () => {
  it('sorts the open columns by priority and leaves Done in its order', () => {
    const low = task('A', { priority: 'low' })
    const urgent = task('B', { priority: 'urgent' })
    const doneOld = task('C', { status: 'done', priority: 'urgent' })
    const doneNew = task('D', { status: 'done', priority: 'low' })
    const sorted = sortBoard(board({ backlog: [low, urgent], done: [doneNew, doneOld] }), new Map())
    expect(sorted.backlog.map((t) => t.id)).toEqual(['B', 'A'])
    expect(sorted.done.map((t) => t.id)).toEqual(['D', 'C'])
  })

  it('puts a working agent first among equal priorities', () => {
    const agents = new Map([['B', { state: 'working' } as AgentStatus]])
    const sorted = sortBoard(board({ in_progress: [task('A'), task('B')] }), agents)
    expect(sorted.in_progress.map((t) => t.id)).toEqual(['B', 'A'])
  })
})

describe('boardTasks and taskSummaries', () => {
  it('flattens the columns and indexes titles and states by id', () => {
    const tasks = boardTasks(
      board({ backlog: [task('A')], in_review: [task('B', { prUrl: 'https://pr' })] })
    )
    expect(tasks.map((t) => t.id)).toEqual(['A', 'B'])
    const { titles, states } = taskSummaries(tasks)
    expect(titles.get('A')).toBe('T A')
    expect(states.get('B')).toEqual({ status: 'backlog', prUrl: 'https://pr' })
  })
})

describe('dispatchQueue', () => {
  it('numbers the waiting tasks from 1 in Dispatch order, with their lane', () => {
    const orchestration = {
      dispatch: [
        { taskId: 'A', lane: 'implement' },
        { taskId: 'B', lane: 'spec' }
      ]
    } as OrchestrationSummary
    expect([...dispatchQueue(orchestration)]).toEqual([
      ['A', { position: 1, lane: 'implement' }],
      ['B', { position: 2, lane: 'spec' }]
    ])
    expect(dispatchQueue(null).size).toBe(0)
  })
})
