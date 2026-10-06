import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shippedSettings } from './config.js'
import type { AgentStatus } from './agentState.js'
import {
  createSessionLifecycle,
  launchPatch,
  monitorKey,
  splitMonitorKey,
  type SessionPorts
} from './sessionLifecycle.js'
import type { Settings, Task, TerminalSessionInfo } from './types.js'

vi.mock('./providers/index.js', () => ({
  providerById: () => ({ sessionExists: (id: string) => id === 'saved-chat' })
}))

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
    activity: [],
    order: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra
  } as unknown as Task
}

const session = (extra: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo =>
  ({ id: 's1', cwd: '/repo', taskId: 'TASK-1', workspaceId: 'default', ...extra }) as never

interface Harness {
  ports: SessionPorts
  settings: Settings
  tasks: Map<string, Task>
  calls: string[]
  writes: string[]
  agentState: { value?: AgentStatus['state'] }
  sessions: TerminalSessionInfo[]
  running: { value: { command?: string } | null }
}

function harness(): Harness {
  const settings = {
    ...shippedSettings(),
    activeWorkspaceId: 'default',
    enabledProviders: ['claude', 'codex']
  } as Settings
  const tasks = new Map<string, Task>([['TASK-1', task()]])
  const calls: string[] = []
  const writes: string[] = []
  const agentState: Harness['agentState'] = {}
  const sessions: TerminalSessionInfo[] = []
  const running: Harness['running'] = { value: { command: 'claude' } }
  const h = { settings, tasks, calls, writes, agentState, sessions, running } as Harness
  h.ports = {
    settings: () => h.settings,
    findTask: (id) => tasks.get(id),
    getTask: (id) => tasks.get(id),
    updateTask: (id, patch) => {
      calls.push(`update ${id} ${Object.keys(patch).sort().join(',')}`)
      tasks.set(id, { ...tasks.get(id)!, ...patch } as Task)
    },
    addNote: (id, author, message) => calls.push(`note ${id} ${author} ${message}`),
    createTask: (draft) => {
      const created = task({ ...draft, id: 'TASK-2' } as Partial<Task>)
      tasks.set(created.id, created)
      calls.push(`create ${created.title}`)
      return created
    },
    notifyTasks: () => calls.push('notifyTasks'),
    notifyAgents: () => calls.push('notifyAgents'),
    recordAgentEvent: (ws, id, event) => calls.push(`event ${ws}:${id} ${event}`),
    pinWorkspace: (ws, work) => {
      calls.push(`pin ${ws}`)
      try {
        return work()
      } finally {
        calls.push('unpin')
      }
    },
    createSession: (request) => {
      calls.push(`session ${request.taskId} ${request.provider}`)
      return session({ taskId: request.taskId })
    },
    findSessionByTask: () => sessions[0],
    listSessions: () => sessions,
    killSession: (id) => calls.push(`kill ${id}`),
    writeToSession: (id, data) => writes.push(`${id}:${data}`),
    runtimeState: () => ({ cwd: '/repo', runningCommand: running.value }),
    agentStatuses: () =>
      agentState.value ? [{ taskId: 'TASK-1', state: agentState.value } as AgentStatus] : [],
    monitor: {
      expect: async (_socket, key, cwd) => void calls.push(`expect ${key} ${cwd}`),
      watch: async (_socket, key, id) => void calls.push(`watch ${key} ${id}`),
      release: (key) => calls.push(`release ${key}`)
    },
    prepareCodex: async () => '/sock',
    planLaunch: (_settings, t, options) => ({
      provider: options.provider ?? 'claude',
      command: 'agent',
      cwd: '/repo',
      sessionId: 'sess-1',
      resumed: false,
      worktreePath: '/repo.worktrees/TASK-1',
      ...(t.id === 'TASK-1' ? {} : {})
    }),
    git: {
      branch: () => 'styr/TASK-1',
      baseBranch: () => 'main',
      workingTree: () => ({ status: '', diffStat: '', commits: '' })
    },
    writeHandoff: (name) => `/handoffs/${name}`
  }
  return h
}

describe('monitor keys', () => {
  it('round-trips a workspace and task', () => {
    expect(splitMonitorKey(monitorKey('ws', 'TASK-1'))).toEqual({
      workspaceId: 'ws',
      taskId: 'TASK-1'
    })
  })
})

describe('launchPatch', () => {
  const settings = shippedSettings()
  const plan = { provider: 'claude' as const, worktreePath: '/wt' }

  it('advances Backlog and records the worktree', () => {
    expect(launchPatch(settings, task(), plan, undefined)).toEqual({
      status: 'in_progress',
      worktreePath: '/wt'
    })
  })

  it('leaves other statuses and a matching worktree alone', () => {
    const t = task({ status: 'in_review', worktreePath: '/wt' })
    expect(launchPatch(settings, t, plan, undefined)).toEqual({})
  })

  it('records the session as pointer and history, labelled by the sessionLabel', () => {
    const patch = launchPatch(settings, task(), plan, undefined, 'abc', 'Fork of X', () => 'NOW')
    expect(patch.agentSession).toEqual({ provider: 'claude', id: 'abc' })
    expect(patch.sessions).toEqual([
      { id: 'abc', provider: 'claude', startedAt: 'NOW', label: 'Fork of X' }
    ])
  })

  it('does not duplicate a known session', () => {
    const t = task({
      status: 'in_progress',
      agentSession: { provider: 'claude', id: 'abc' },
      sessions: [{ id: 'abc', provider: 'claude', startedAt: 'x', label: 'y' }]
    } as Partial<Task>)
    expect(launchPatch(settings, t, { provider: 'claude' }, undefined, 'abc')).toEqual({})
  })
})

describe('startForTask', () => {
  it('records metadata, then creates the session with the workspace env', async () => {
    const h = harness()
    const info = await createSessionLifecycle(h.ports).startForTask('TASK-1')
    expect(info.taskId).toBe('TASK-1')
    expect(h.calls).toEqual([
      'update TASK-1 agentSession,sessions,status,worktreePath',
      'notifyTasks',
      'session TASK-1 claude'
    ])
  })

  it('returns the live session instead of starting another', async () => {
    const h = harness()
    h.sessions.push(session({ id: 'live' }))
    const info = await createSessionLifecycle(h.ports).startForTask('TASK-1')
    expect(info.id).toBe('live')
    expect(h.calls).toEqual([])
  })

  it('refuses a missing task and a disabled provider', async () => {
    const h = harness()
    const lifecycle = createSessionLifecycle(h.ports)
    await expect(lifecycle.startForTask('NOPE')).rejects.toThrow('not found')
    h.settings = { ...h.settings, enabledProviders: ['claude'] }
    await expect(lifecycle.startForTask('TASK-1', { provider: 'codex' })).rejects.toThrow(
      'Codex is disabled'
    )
  })

  it('writes nothing when the workspace changes while Codex is checked', async () => {
    const h = harness()
    h.ports.prepareCodex = async () => {
      h.settings = { ...h.settings, activeWorkspaceId: 'other' }
      return '/sock'
    }
    await expect(
      createSessionLifecycle(h.ports).startForTask('TASK-1', { provider: 'codex' })
    ).rejects.toThrow('workspace changed')
    expect(h.calls).toEqual([])
  })

  it('defers a fresh Codex thread id to the monitor, then saves it on the bound update', async () => {
    const h = harness()
    const lifecycle = createSessionLifecycle(h.ports)
    await lifecycle.startForTask('TASK-1', { provider: 'codex', templateId: 'spec' })
    expect(h.calls).toEqual([
      'update TASK-1 status,worktreePath',
      'notifyTasks',
      'expect default:TASK-1 /repo',
      'session TASK-1 codex'
    ])
    h.calls.length = 0
    lifecycle.recordCodexUpdate({
      taskId: 'default:TASK-1',
      event: 'SessionStart',
      boundSessionId: 'thread-9'
    } as never)
    expect(h.calls).toEqual([
      'event default:TASK-1 SessionStart',
      'update TASK-1 agentSession,sessions',
      'notifyTasks',
      'notifyAgents'
    ])
  })

  it('watches a resumed Codex thread and marks the session ready', async () => {
    const h = harness()
    h.ports.planLaunch = () => ({
      provider: 'codex',
      command: 'a',
      cwd: '/repo',
      sessionId: 'thread-1',
      resumed: true
    })
    await createSessionLifecycle(h.ports).startForTask('TASK-1', { provider: 'codex' })
    expect(h.calls).toEqual([
      'update TASK-1 agentSession,sessions,status',
      'notifyTasks',
      'watch default:TASK-1 thread-1',
      'session TASK-1 codex',
      'event default:TASK-1 SessionStart',
      'notifyAgents'
    ])
  })

  it('shares one launch between simultaneous requests', async () => {
    const h = harness()
    const lifecycle = createSessionLifecycle(h.ports)
    const [a, b] = await Promise.all([
      lifecycle.startForTask('TASK-1'),
      lifecycle.startForTask('TASK-1')
    ])
    expect(a).toBe(b)
    expect(h.calls.filter((c) => c.startsWith('session'))).toHaveLength(1)
  })

  it('releases the monitor when the session cannot be created', async () => {
    const h = harness()
    h.ports.createSession = () => {
      throw new Error('spawn failed')
    }
    await expect(
      createSessionLifecycle(h.ports).startForTask('TASK-1', { provider: 'codex' })
    ).rejects.toThrow('spawn failed')
    expect(h.calls).toContain('release default:TASK-1')
  })

  it('notes a worktree warning on the task', async () => {
    const h = harness()
    h.ports.planLaunch = () => ({
      provider: 'claude',
      command: 'a',
      cwd: '/repo',
      sessionId: 's',
      resumed: false,
      warning: 'no worktree'
    })
    await createSessionLifecycle(h.ports).startForTask('TASK-1')
    expect(h.calls).toContain('note TASK-1 styr no worktree')
  })
})

describe('recordCodexUpdate', () => {
  it('writes a background workspace through the pin, from files, without notifying the board', () => {
    const h = harness()
    h.tasks.set('TASK-1', task({ status: 'in_progress' }))
    createSessionLifecycle(h.ports).recordCodexUpdate({
      taskId: 'other:TASK-1',
      event: 'Stop',
      boundSessionId: 'thread-9'
    } as never)
    expect(h.calls).toEqual([
      'event other:TASK-1 Stop',
      'pin other',
      'update TASK-1 agentSession,sessions',
      'unpin',
      'notifyAgents'
    ])
  })

  it('only records the event when no thread was bound', () => {
    const h = harness()
    createSessionLifecycle(h.ports).recordCodexUpdate({
      taskId: 'default:TASK-1',
      event: 'Stop'
    } as never)
    expect(h.calls).toEqual(['event default:TASK-1 Stop', 'notifyAgents'])
  })
})

describe('askForPullRequest', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('types the request, then Enter in a separate write', () => {
    const h = harness()
    h.sessions.push(session())
    createSessionLifecycle(h.ports).askForPullRequest('TASK-1')
    expect(h.writes).toHaveLength(1)
    vi.advanceTimersByTime(250)
    expect(h.writes[1]).toBe('s1:\r')
  })

  it('refuses without a running agent and while it is working or waiting', () => {
    const h = harness()
    const lifecycle = createSessionLifecycle(h.ports)
    expect(() => lifecycle.askForPullRequest('TASK-1')).toThrow('no running agent')
    h.sessions.push(session())
    h.running.value = null
    expect(() => lifecycle.askForPullRequest('TASK-1')).toThrow('no running agent')
    h.running.value = { command: 'claude' }
    for (const state of ['working', 'waiting'] as const) {
      h.agentState.value = state
      expect(() => lifecycle.askForPullRequest('TASK-1')).toThrow('still working')
    }
    expect(h.writes).toEqual([])
  })
})

describe('askReview', () => {
  it('requires In Review', async () => {
    const h = harness()
    await expect(createSessionLifecycle(h.ports).askReview('TASK-1')).rejects.toThrow(
      'not in review'
    )
  })

  it('refuses while the live agent is mid-turn and keeps its session', async () => {
    const h = harness()
    h.tasks.set('TASK-1', task({ status: 'in_review' }))
    h.sessions.push(session())
    h.agentState.value = 'working'
    await expect(createSessionLifecycle(h.ports).askReview('TASK-1')).rejects.toThrow(
      'still working'
    )
    expect(h.calls).toEqual([])
  })

  it('kills an idle agent and starts the reviewer', async () => {
    const h = harness()
    h.tasks.set('TASK-1', task({ status: 'in_review' }))
    h.sessions.push(session())
    h.ports.findSessionByTask = vi
      .fn()
      .mockReturnValueOnce(h.sessions[0])
      .mockReturnValue(undefined)
    await createSessionLifecycle(h.ports).askReview('TASK-1')
    expect(h.calls[0]).toBe('kill s1')
    expect(h.calls).toContain('session TASK-1 claude')
  })
})

describe('askFork', () => {
  it('throws for an unknown session and returns null where there is nothing to fork', async () => {
    const h = harness()
    const lifecycle = createSessionLifecycle(h.ports)
    await expect(lifecycle.askFork('gone', 'q')).rejects.toThrow('gone')
    h.sessions.push(session({ taskId: undefined }))
    expect(await lifecycle.askFork('s1', 'q')).toBeNull()
    h.sessions[0] = session({ workspaceId: 'other' })
    expect(await lifecycle.askFork('s1', 'q')).toBeNull()
    h.sessions[0] = session()
    expect(await lifecycle.askFork('s1', 'q')).toBeNull() // task has no agentSession
    h.tasks.set(
      'TASK-1',
      task({ agentSession: { provider: 'claude', id: 'lost-chat' } } as Partial<Task>)
    )
    expect(await lifecycle.askFork('s1', 'q')).toBeNull() // the chat is gone from disk
    expect(h.calls).toEqual([])
  })

  it('creates an answer task, notes the source and launches a fork of its chat', async () => {
    const h = harness()
    h.sessions.push(session())
    h.ports.findSessionByTask = (taskId) => (taskId === 'TASK-1' ? h.sessions[0] : undefined)
    h.tasks.set(
      'TASK-1',
      task({ agentSession: { provider: 'claude', id: 'saved-chat' } } as Partial<Task>)
    )
    const plan = vi.fn(h.ports.planLaunch)
    h.ports.planLaunch = plan
    await createSessionLifecycle(h.ports).askFork('s1', 'Why?')
    expect(h.calls[0]).toBe('create Why?')
    expect(h.calls[1]).toBe('note TASK-1 styr Forked for a question as TASK-2')
    expect(h.calls).toContain('session TASK-2 claude')
    expect(plan.mock.calls[0][2]).toMatchObject({
      forkFrom: 'saved-chat',
      withPrompt: true,
      sessionLabel: 'Fork of TASK-1'
    })
  })

  it('says where the question was saved when the launch fails', async () => {
    const h = harness()
    h.sessions.push(session())
    h.ports.findSessionByTask = (taskId) => (taskId === 'TASK-1' ? h.sessions[0] : undefined)
    h.tasks.set(
      'TASK-1',
      task({ agentSession: { provider: 'claude', id: 'saved-chat' } } as Partial<Task>)
    )
    h.ports.createSession = () => {
      throw new Error('spawn failed')
    }
    await expect(createSessionLifecycle(h.ports).askFork('s1', 'Why?')).rejects.toThrow(
      'spawn failed (the question is saved as TASK-2 in Backlog)'
    )
  })
})

describe('handOff', () => {
  it('creates a continuing task, notes the source, and asks a running agent last', () => {
    vi.useFakeTimers()
    const h = harness()
    h.sessions.push(session())
    const result = createSessionLifecycle(h.ports).handOff('s1', 'out')
    expect(result).toMatchObject({ taskId: 'TASK-2', agentAsked: true })
    expect(result.path).toMatch(/^\/handoffs\/TASK-1-/)
    expect(h.calls.map((c) => c.split(' ')[0])).toEqual(['create', 'note', 'notifyTasks'])
    expect(h.writes).toHaveLength(1)
    vi.useRealTimers()
  })

  it('does not ask a bare shell', () => {
    const h = harness()
    h.sessions.push(session({ taskId: undefined }))
    h.running.value = { command: 'ls' }
    const result = createSessionLifecycle(h.ports).handOff('s1', '')
    expect(result.agentAsked).toBe(false)
    expect(h.writes).toEqual([])
  })
})
