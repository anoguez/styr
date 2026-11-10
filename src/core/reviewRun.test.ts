import { describe, expect, it } from 'vitest'
import type { AgentStatus } from './agentState.js'
import { finishedReviewRuns, REVIEW_RUN_TAG, reviewedTask } from './reviewRun.js'
import type { Task } from './types.js'

const task = (extra: Partial<Task>): Task =>
  ({ tags: [], status: 'in_review', sessions: [], ...extra }) as unknown as Task

const reviewed = (status: Task['status'] = 'in_review') =>
  task({
    id: 'TASK-1',
    status,
    sessions: [
      { id: 'impl', provider: 'claude', startedAt: 'a', label: 'I' },
      { id: 'rev', provider: 'claude', startedAt: 'b', label: 'R' }
    ]
  })
const run = task({
  id: 'TASK-2',
  status: 'in_progress',
  tags: [REVIEW_RUN_TAG],
  agentSession: { provider: 'claude', id: 'rev' },
  sessions: [{ id: 'rev', provider: 'claude', startedAt: 'b', label: 'R' }]
})
const idle = [{ taskId: 'TASK-2', state: 'idle' } as AgentStatus]

describe('reviewedTask', () => {
  it('is the other task whose history holds the run chat', () => {
    expect(reviewedTask(run, [run, reviewed()])?.id).toBe('TASK-1')
    expect(reviewedTask({ ...run, agentSession: undefined }, [run, reviewed()])).toBeUndefined()
  })
})

describe('finishedReviewRuns', () => {
  it('lists a run whose reviewer stopped once the reviewed task left In Review', () => {
    expect(finishedReviewRuns([reviewed('done'), run], idle)).toEqual([run])
    expect(finishedReviewRuns([reviewed('backlog'), run], idle)).toEqual([run])
  })

  it('keeps a run still reviewing, or whose task is still In Review', () => {
    const working = [{ taskId: 'TASK-2', state: 'working' } as AgentStatus]
    expect(finishedReviewRuns([reviewed('done'), run], working)).toEqual([])
    expect(finishedReviewRuns([reviewed(), run], idle)).toEqual([])
  })

  it('reads the reviewed task fresh, ahead of the index', () => {
    const fresh = (t: Task) => (t.id === 'TASK-1' ? reviewed('done') : t)
    expect(finishedReviewRuns([reviewed(), run], idle, fresh)).toEqual([run])
  })

  it('ignores an archived run and tasks that are not runs', () => {
    const archived = { ...run, archivedAt: 'x' }
    expect(finishedReviewRuns([reviewed('done'), archived], idle)).toEqual([])
    expect(finishedReviewRuns([reviewed('done'), { ...run, tags: [] }], idle)).toEqual([])
  })
})
