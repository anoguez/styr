import { beforeEach, describe, expect, it } from 'vitest'
import { shippedSettings } from '@core/config.js'
import type { Task, TaskFilter } from '@core/types.js'
import { createTasksService, type TasksService, type TasksServicePorts } from './tasksService.js'

function task(extra: Partial<Task> = {}): Task {
  return { id: 'TASK-1', title: 'T', status: 'backlog', ...extra } as Task
}

interface Harness {
  ports: TasksServicePorts
  calls: string[]
  rows: Task[]
}

function harness(): Harness {
  const calls: string[] = []
  const h = { calls, rows: [task()] } as Harness
  h.ports = {
    broadcast: (channel) => calls.push(`broadcast ${channel}`),
    index: {
      sync: () => calls.push('sync'),
      query: (filter?: TaskFilter) => {
        if (filter && Object.keys(filter).length) calls.push(`query ${JSON.stringify(filter)}`)
        return h.rows
      },
      find: (id) => h.rows.find((row) => row.id === id)
    },
    store: {
      createTask: (draft) => {
        calls.push(`create ${draft.title}`)
        return task({ id: 'TASK-2', title: draft.title })
      },
      updateTask: (id, patch) => {
        calls.push(`update ${id} ${Object.keys(patch).join(',')}`)
        return task({ id, ...patch } as Partial<Task>)
      },
      addNote: (id) => task({ id }),
      reorderTasks: () => [],
      setArchived: (id, archived) => {
        calls.push(`archive ${id} ${archived}`)
        return task({ id })
      },
      deleteTask: (id) => calls.push(`delete ${id}`),
      removeWorktree: (t) => calls.push(`removeWorktree ${t.id}`),
      brokenTaskFiles: () => [{ filePath: '/tasks/bad.md', reason: 'no frontmatter' }]
    },
    settings: () => shippedSettings(),
    requestLanding: () => calls.push('landing'),
    observeTasks: (tasks) => calls.push(`observe ${tasks.length}`),
    recordNotifyDuration: (ms) => calls.push(`time ${typeof ms}`),
    requestAutoRun: () => calls.push('autoRun'),
    notifyAgents: () => calls.push('notifyAgents')
  }
  return h
}

let h: Harness
let service: TasksService

beforeEach(() => {
  h = harness()
  service = createTasksService(h.ports)
})

/** One `notifyTasksChanged`, as the call log records it. */
const NOTIFY = ['sync', 'observe 1', 'time number', 'broadcast tasks:changed', 'landing', 'autoRun']

describe('notifyTasksChanged', () => {
  it('re-indexes, observes, times, broadcasts once, then requests landing and Auto-run', () => {
    service.notifyTasksChanged()
    expect(h.calls).toEqual(NOTIFY)
  })

  it('only requests the landing pass: it runs no git and re-indexes once', () => {
    service.notifyTasksChanged()
    expect(h.calls.filter((call) => call === 'landing')).toHaveLength(1)
    expect(h.calls.filter((call) => call === 'sync')).toHaveLength(1)
  })

  it('is synchronous: everything has run when it returns', () => {
    const result: unknown = service.notifyTasksChanged()
    expect(result).toBeUndefined()
    expect(h.calls).toContain('broadcast tasks:changed')
  })
})

describe('reads', () => {
  it('lists with the filter validated, an absent filter meaning all', () => {
    expect(service.list(undefined)).toEqual(h.rows)
    expect(h.calls).toEqual([])
    service.list({ status: 'backlog' })
    expect(h.calls).toEqual(['query {"status":"backlog"}'])
    expect(() => service.list({ status: 'nope' })).toThrow()
  })

  it('gets from the index, and reports the files that failed to parse', () => {
    expect(service.get('TASK-1')).toBe(h.rows[0])
    expect(service.get('TASK-9')).toBeUndefined()
    expect(service.problems()).toEqual([{ filePath: '/tasks/bad.md', reason: 'no frontmatter' }])
  })
})

describe('writes', () => {
  it('writes, then runs one full notify', () => {
    service.update('TASK-1', { title: 'Renamed' })
    expect(h.calls).toEqual(['update TASK-1 title', ...NOTIFY])
  })

  it('validates the draft before anything is written or broadcast', () => {
    expect(() => service.create({ title: 42 })).toThrow()
    expect(h.calls).toEqual([])
    service.create({ title: 'New' })
    expect(h.calls[0]).toBe('create New')
  })

  it('re-broadcasts the agents after an archive, which drops the task from every agent list', () => {
    service.archive('TASK-1', true)
    expect(h.calls).toEqual(['archive TASK-1 true', ...NOTIFY, 'notifyAgents'])
  })

  it('removes the worktree through the store and forgets its path on the task', () => {
    h.rows = [task({ repoPath: '/repo', worktreePath: '/wt' })]
    service.removeWorktree('TASK-1')
    expect(h.calls.slice(0, 2)).toEqual(['removeWorktree TASK-1', 'update TASK-1 worktreePath'])
  })
})

describe('spec hand-off', () => {
  const handedBack = (): Task =>
    task({
      status: 'backlog',
      readiness: 'ready',
      sessions: [
        { id: 'c1', provider: 'claude', startedAt: 'x', label: 'Spec', templateId: 'spec' }
      ],
      agentSession: { provider: 'claude', id: 'c1' }
    } as Partial<Task>)

  it('clears the pointer of a spec run handed back, with one write and a second sync', () => {
    h.rows = [handedBack()]
    service.notifyTasksChanged()
    expect(h.calls.filter((call) => call.startsWith('update'))).toEqual([
      'update TASK-1 agentSession'
    ])
    expect(h.calls.filter((call) => call === 'sync')).toHaveLength(2)
  })

  it('writes nothing once the pointer is gone, or when nothing qualifies', () => {
    h.rows = [{ ...handedBack(), agentSession: undefined }, task({ status: 'in_progress' })]
    service.notifyTasksChanged()
    expect(h.calls.some((call) => call.startsWith('update'))).toBe(false)
    expect(h.calls.filter((call) => call === 'sync')).toHaveLength(1)
  })
})
