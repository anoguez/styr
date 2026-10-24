import { beforeEach, describe, expect, it } from 'vitest'
import { createTaskWrites, type TaskWritePorts, type TaskWrites } from './taskWrites.js'
import type { Task } from '@core/types.js'

function task(extra: Partial<Task> = {}): Task {
  return {
    id: 'TASK-1',
    title: 'T',
    description: '',
    status: 'backlog',
    priority: 'medium',
    readiness: 'ready',
    tags: [],
    contextFiles: [],
    orchestrate: false,
    repoPath: '/repo',
    filePath: '/tasks/TASK-1.md',
    sessions: [],
    questions: [],
    activity: [],
    order: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra
  } as unknown as Task
}

interface Harness {
  route: 'queued' | 'now' | 'resume' | 'fresh'
  failDelivery: boolean
  writes: TaskWrites
  tasks: Map<string, Task>
  /** Store writes and notifies, in order. */
  calls: string[]
}

function harness(): Harness {
  const tasks = new Map<string, Task>([['TASK-1', task()]])
  const calls: string[] = []
  const found = (id: string): Task => {
    const existing = tasks.get(id)
    if (!existing) throw new Error(`Task ${id} not found`)
    return existing
  }
  const harnessState = { route: 'now' as Harness['route'], failDelivery: false }
  const ports: TaskWritePorts = {
    findTask: (id) => tasks.get(id),
    createTask: (draft) => {
      calls.push(`create ${draft.title}`)
      const created = task({ ...draft, id: 'TASK-2' } as Partial<Task>)
      tasks.set(created.id, created)
      return created
    },
    updateTask: (id, patch) => {
      calls.push(`update ${id} ${Object.keys(patch).sort().join(',')}`)
      const updated = { ...found(id), ...patch } as Task
      tasks.set(id, updated)
      return updated
    },
    addNote: (id, author, message) => {
      calls.push(`note ${id} ${author} ${message}`)
      return found(id)
    },
    reorderTasks: (status, orderedIds) => {
      calls.push(`reorder ${status} ${orderedIds.join(',')}`)
      return orderedIds.map(found)
    },
    setArchived: (id, archived) => {
      calls.push(`archive ${id} ${archived}`)
      return found(id)
    },
    deleteTask: (id) => {
      calls.push(`delete ${id}`)
      found(id)
      tasks.delete(id)
    },
    answerQuestion: (id, questionId, answer) => {
      calls.push(`answer ${id} ${questionId}`)
      const current = found(id)
      const question = current.questions.find((candidate) => candidate.id === questionId)
      if (!question) throw new Error(`Question ${questionId} not found`)
      if (question.answer !== undefined)
        throw new Error(`Question ${questionId} is already answered`)
      const updated = {
        ...current,
        questions: current.questions.map((candidate) =>
          candidate.id === questionId ? { ...candidate, answer } : candidate
        )
      }
      tasks.set(id, updated)
      return updated
    },
    route: () => ({ route: harnessState.route }),
    deliver: (id, message) => {
      calls.push(`deliver ${id} ${message.split('\n')[0]}`)
      return harnessState.failDelivery
        ? Promise.reject(new Error('no terminal'))
        : Promise.resolve()
    },
    removeWorktree: (target) => calls.push(`removeWorktree ${target.id} ${target.repoPath}`),
    notifyTasks: () => calls.push('notifyTasks'),
    notifyAgents: () => calls.push('notifyAgents')
  }
  return {
    writes: createTaskWrites(ports),
    tasks,
    calls,
    get route() {
      return harnessState.route
    },
    set route(value) {
      harnessState.route = value
    },
    get failDelivery() {
      return harnessState.failDelivery
    },
    set failDelivery(value) {
      harnessState.failDelivery = value
    }
  }
}

const count = (calls: string[], name: string): number =>
  calls.filter((call) => call === name).length

describe('createTaskWrites', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  const mutations: [string, (writes: TaskWrites) => unknown][] = [
    ['create', (w) => w.create({ title: 'New' })],
    ['update', (w) => w.update('TASK-1', { title: 'Renamed' })],
    ['note', (w) => w.note('TASK-1', 'me', 'hello')],
    ['reorder', (w) => w.reorder('backlog', ['TASK-1'])],
    ['archive', (w) => w.archive('TASK-1', true)],
    ['delete', (w) => w.delete('TASK-1')],
    ['forgetSession', (w) => w.forgetSession('TASK-1')],
    ['removeAgent', (w) => w.removeAgent('TASK-1')],
    ['removeWorktree', (w) => w.removeWorktree('TASK-1')]
  ]

  it.each(mutations)('%s re-indexes exactly once', (_name, run) => {
    run(h.writes)
    expect(count(h.calls, 'notifyTasks')).toBe(1)
  })

  it('re-indexes after the write, not before', () => {
    h.writes.update('TASK-1', { title: 'Renamed' })
    expect(h.calls).toEqual(['update TASK-1 title', 'notifyTasks'])
  })

  it('archive and removeAgent also re-broadcast the agents, once', () => {
    for (const name of ['archive', 'removeAgent']) {
      const fresh = harness()
      mutations.find(([key]) => key === name)![1](fresh.writes)
      expect(count(fresh.calls, 'notifyAgents'), name).toBe(1)
    }
  })

  it('no other mutation touches the agents', () => {
    for (const [name, run] of mutations) {
      if (name === 'archive' || name === 'removeAgent') continue
      const fresh = harness()
      run(fresh.writes)
      expect(count(fresh.calls, 'notifyAgents'), name).toBe(0)
    }
  })

  it('archives through setArchived, not a patch', () => {
    h.writes.archive('TASK-1', true)
    expect(h.calls).toEqual(['archive TASK-1 true', 'notifyTasks', 'notifyAgents'])
  })

  it('rejects an invalid draft or patch before writing', () => {
    expect(() => h.writes.create({})).toThrow()
    expect(() => h.writes.update('TASK-1', { status: 'nowhere' })).toThrow()
    expect(h.calls).toEqual([])
  })

  it('rejects an unknown status before reordering', () => {
    expect(() => h.writes.reorder('nowhere' as never, ['TASK-1'])).toThrow('Unknown status')
    expect(h.calls).toEqual([])
  })

  it('notifies nothing when the store write fails', () => {
    expect(() => h.writes.note('TASK-9', 'me', 'hi')).toThrow('not found')
    expect(h.calls).toEqual(['note TASK-9 me hi'])
  })

  it('removeWorktree drops the worktree, then clears the path', () => {
    h.tasks.set('TASK-1', task({ worktreePath: '/wt' }))
    const updated = h.writes.removeWorktree('TASK-1')
    expect(updated?.worktreePath).toBeUndefined()
    expect(h.calls).toEqual([
      'removeWorktree TASK-1 /repo',
      'update TASK-1 worktreePath',
      'notifyTasks'
    ])
  })

  it('removeWorktree writes nothing for a task without a repository', () => {
    h.tasks.set('TASK-1', task({ repoPath: undefined }))
    expect(h.writes.removeWorktree('TASK-1')).toBeNull()
    expect(h.writes.removeWorktree('TASK-9')).toBeNull()
    expect(h.calls).toEqual([])
  })

  it('removeAgent forgets the chat only when there is one', () => {
    h.writes.removeAgent('TASK-1')
    expect(h.calls).toEqual(['notifyTasks', 'notifyAgents'])

    const withChat = harness()
    withChat.tasks.set('TASK-1', task({ agentSession: { provider: 'claude', id: 'c1' } }))
    withChat.writes.removeAgent('TASK-1')
    expect(withChat.calls).toEqual(['update TASK-1 agentSession', 'notifyTasks', 'notifyAgents'])
  })

  describe('answerQuestion', () => {
    const ask = (): void => {
      h.tasks.set(
        'TASK-1',
        task({
          questions: [
            { id: 'q1', askedAt: '2026-01-01T00:00:00Z', askedBy: 'claude', text: 'Is X ok?' }
          ]
        })
      )
    }

    it.each(['queued', 'now', 'resume'] as const)(
      'records, then delivers by the %s route',
      async (route) => {
        ask()
        h.route = route
        const result = await h.writes.answerQuestion('TASK-1', 'q1', 'Yes')
        expect(result.delivery).toBe(route)
        expect(h.calls).toEqual([
          'answer TASK-1 q1',
          'notifyTasks',
          'deliver TASK-1 The owner answered your question q1 (ask_owner):'
        ])
      }
    )

    it('records an answer without launching an agent that has no chat', async () => {
      ask()
      h.route = 'fresh'
      const result = await h.writes.answerQuestion('TASK-1', 'q1', 'Yes')
      expect(result.delivery).toBe('recorded')
      expect(h.calls).toEqual(['answer TASK-1 q1', 'notifyTasks'])
    })

    it('keeps the answer when the delivery fails', async () => {
      ask()
      h.failDelivery = true
      const result = await h.writes.answerQuestion('TASK-1', 'q1', 'Yes')
      expect(result).toMatchObject({ delivery: 'failed', error: 'no terminal' })
      expect(h.tasks.get('TASK-1')?.questions[0]?.answer).toBe('Yes')
    })

    it('refuses a second answer and delivers nothing', async () => {
      ask()
      await h.writes.answerQuestion('TASK-1', 'q1', 'Yes')
      h.calls.length = 0
      await expect(h.writes.answerQuestion('TASK-1', 'q1', 'No')).rejects.toThrow(
        'already answered'
      )
      expect(h.calls).toEqual(['answer TASK-1 q1'])
    })
  })
})
