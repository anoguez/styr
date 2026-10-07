import { describe, expect, it } from 'vitest'
import { shippedSettings } from './config.js'
import { AUTO_LAUNCH_LIMIT, decideAutoRun, memoryKey, pruneMemory } from './autoDispatch.js'
import { planOrchestration } from './orchestrate.js'
import type { Task } from './types.js'

function task(extra: Partial<Task> = {}): Task {
  return {
    id: 'TASK-1',
    title: 'T',
    description: '',
    status: 'backlog',
    priority: 'medium',
    readiness: 'ready',
    tags: [],
    blockedBy: [],
    contextFiles: [],
    orchestrate: true,
    repoPath: '/repo',
    filePath: '/tasks/TASK-1.md',
    order: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra
  } as unknown as Task
}

function decide(tasks: Task[], memory = new Map<string, string>(), history: number[] = []) {
  const pruned = pruneMemory(tasks, 'w', memory)
  const plan = planOrchestration(shippedSettings(), tasks, {
    liveTaskIds: new Set(),
    agents: new Map(),
    skip: pruned.skip
  })
  return decideAutoRun({ plan, workspaceId: 'w', memory: pruned.memory, history, now: 10_000_000 })
}

describe('decideAutoRun', () => {
  it('launches what the plan dispatches and remembers it', () => {
    const decision = decide([task()])
    expect(decision.launch.map((l) => l.task.id)).toEqual(['TASK-1'])
    expect(decision.memory.get(memoryKey('w', 'TASK-1'))).toBe('implement|backlog|ready')
  })

  it('does not start the same review again while the task is unchanged', () => {
    const review = task({ status: 'in_review' })
    const first = decide([review])
    expect(first.launch).toHaveLength(1)
    expect(decide([review], first.memory).launch).toEqual([])
  })

  it('a remembered review does not hold the review slot against the next one', () => {
    const first = task({ status: 'in_review' })
    const second = task({ id: 'TASK-2', status: 'in_review', order: 1 })
    const started = decide([first, second])
    expect(started.launch.map((l) => l.task.id)).toEqual(['TASK-1'])
    // The reviewer went idle; the task is still In Review. Only the other task is next.
    expect(decide([first, second], started.memory).launch.map((l) => l.task.id)).toEqual(['TASK-2'])
  })

  it('forgets a task that moved on, so a later return to review runs again', () => {
    const review = task({ status: 'in_review' })
    const first = decide([review])
    const away = decide([task({ status: 'in_progress' })], first.memory)
    expect(away.memory.size).toBe(0)
    expect(decide([review], away.memory).launch).toHaveLength(1)
  })

  it('keeps memory of other workspaces', () => {
    const memory = new Map([[memoryKey('other', 'TASK-1'), 'implement|backlog|ready']])
    expect(decide([], memory).memory.get(memoryKey('other', 'TASK-1'))).toBeDefined()
  })

  it('stops at the hourly limit and asks to pause', () => {
    const history = Array.from({ length: AUTO_LAUNCH_LIMIT - 1 }, () => 9_999_000)
    const tasks = [task(), task({ id: 'TASK-2', order: 1 })]
    const decision = decide(tasks, new Map(), history)
    expect(decision.launch).toHaveLength(1)
    expect(decision.pause).toBe('limit')
  })

  it('does not count launches older than an hour', () => {
    const history = Array.from({ length: AUTO_LAUNCH_LIMIT }, () => 1)
    const decision = decide([task()], new Map(), history)
    expect(decision.launch).toHaveLength(1)
    expect(decision.pause).toBeUndefined()
  })
})
