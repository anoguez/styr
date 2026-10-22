import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shippedSettings } from './config.js'
import type { AgentStatus } from './agentState.js'
import {
  REWORK_PREFACE,
  createSessionLifecycle,
  isReviewSession,
  launchPatch,
  monitorKey,
  reworkLaunch,
  splitMonitorKey,
  type SessionPorts
} from './sessionLifecycle.js'
import type { LaunchOptions } from './launch.js'
import { resolveTemplateFor } from './prompt.js'
import { syntaxFor } from './shell.js'
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
  inbox: { listens: boolean; takes: boolean }
  launches: LaunchOptions[]
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
  const inbox = { listens: false, takes: true }
  const launches: LaunchOptions[] = []
  const h = {
    settings,
    tasks,
    calls,
    writes,
    agentState,
    sessions,
    running,
    inbox,
    launches
  } as Harness
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
    recordSubagentEvent: (ws, id, event, subagent) =>
      calls.push(`subagent ${ws}:${id} ${event}${subagent ? ` ${subagent.id}` : ''}`),
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
    runtimeState: () => ({
      cwd: '/repo',
      runningCommand: running.value,
      promptReady: running.value === null
    }),
    agentStatuses: () =>
      agentState.value ? [{ taskId: 'TASK-1', state: agentState.value } as AgentStatus] : [],
    promptInbox: () => inbox.listens,
    promptAgent: async (id, text) => {
      calls.push(`prompt ${id} ${text}`)
      return inbox.takes
    },
    monitor: {
      expect: async (_socket, key, cwd) => void calls.push(`expect ${key} ${cwd}`),
      watch: async (_socket, key, id) => void calls.push(`watch ${key} ${id}`),
      release: (key) => calls.push(`release ${key}`)
    },
    ensureAgentCli: async () => undefined,
    prepareCodex: async () => '/sock',
    planLaunch: (_settings, t, options) => (
      launches.push(options),
      {
        provider: options.provider ?? 'claude',
        command: 'agent',
        cwd: '/repo',
        sessionId: 'sess-1',
        resumed: false,
        worktreePath: '/repo.worktrees/TASK-1',
        ...(t.id === 'TASK-1' ? {} : {})
      }
    ),
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

  it('records the branch a new worktree was cut from when none was chosen', () => {
    const cut = { ...plan, worktreeBase: 'release/1.1.0' }
    expect(launchPatch(settings, task(), cut, undefined)).toMatchObject({
      baseBranch: 'release/1.1.0'
    })
    expect(launchPatch(settings, task({ baseBranch: 'main' }), cut, undefined)).not.toHaveProperty(
      'baseBranch'
    )
  })

  it('leaves other statuses and a matching worktree alone', () => {
    const t = task({ status: 'in_review', worktreePath: '/wt' })
    expect(launchPatch(settings, t, plan, undefined)).toEqual({})
  })

  it('records the session as pointer and history, labelled by the sessionLabel', () => {
    const patch = launchPatch(settings, task(), plan, undefined, 'abc', 'Fork of X', () => 'NOW')
    expect(patch.agentSession).toEqual({ provider: 'claude', id: 'abc' })
    expect(patch.sessions).toEqual([
      {
        id: 'abc',
        provider: 'claude',
        startedAt: 'NOW',
        label: 'Fork of X',
        templateId: 'implement'
      }
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

describe('rework after a failed review', () => {
  const settings = shippedSettings()
  const implementer = {
    id: 'saved-chat',
    provider: 'claude' as const,
    startedAt: '1',
    label: 'Implement the task',
    templateId: 'implement'
  }
  const reviewer = {
    id: 'review-chat',
    provider: 'claude' as const,
    startedAt: '2',
    label: 'Review the work',
    templateId: 'code-review'
  }
  const bounced = (extra: Partial<Task> = {}): Task =>
    task({
      status: 'backlog',
      agentSession: { provider: 'claude', id: 'review-chat' },
      sessions: [implementer, reviewer],
      ...extra
    } as Partial<Task>)
  const onDisk = (ids: string[]) => (entry: { id: string }) => ids.includes(entry.id)

  it('tells a review run from an implement run, by template id or, for older entries, by name', () => {
    const t = bounced()
    expect(isReviewSession(settings, t, reviewer)).toBe(true)
    expect(isReviewSession(settings, t, implementer)).toBe(false)
    const { templateId: _, ...legacy } = reviewer
    expect(isReviewSession(settings, t, legacy)).toBe(true)
    // A pinned template runs both lanes, so neither counts as a review.
    expect(isReviewSession(settings, bounced({ promptTemplateId: 'implement' }), reviewer)).toBe(
      false
    )
  })

  it('resumes the implementer, not the reviewer, with the prompt and the rework preface', () => {
    expect(
      reworkLaunch(
        settings,
        bounced(),
        { provider: 'claude' },
        onDisk(['saved-chat', 'review-chat'])
      )
    ).toEqual({
      provider: 'claude',
      resume: 'saved-chat',
      withPrompt: true,
      promptPreface: REWORK_PREFACE
    })
  })

  it("starts fresh, still with the preface, when the implementer's chat is gone", () => {
    expect(reworkLaunch(settings, bounced(), {}, onDisk(['review-chat']))).toEqual({
      provider: 'claude',
      fresh: true,
      withPrompt: true,
      promptPreface: REWORK_PREFACE
    })
  })

  it('only resumes an implementer of the provider the lane asked for', () => {
    expect(
      reworkLaunch(settings, bounced(), { provider: 'codex' }, onDisk(['saved-chat']))
    ).toEqual({ provider: 'codex', fresh: true, withPrompt: true, promptPreface: REWORK_PREFACE })
  })

  it('leaves every other launch alone', () => {
    const all = onDisk(['saved-chat', 'review-chat'])
    const options = { withPrompt: true }
    // The current chat is the implementer's own.
    const own = bounced({ agentSession: { provider: 'claude', id: 'saved-chat' } })
    expect(reworkLaunch(settings, own, options, all)).toBe(options)
    // The review lane, a fresh start, a named chat, another template.
    expect(reworkLaunch(settings, bounced({ status: 'in_review' }), options, all)).toBe(options)
    const fresh = { fresh: true }
    expect(reworkLaunch(settings, bounced(), fresh, all)).toBe(fresh)
    const resume = { resume: 'review-chat' }
    expect(reworkLaunch(settings, bounced(), resume, all)).toBe(resume)
    const followup = { templateId: 'followup' }
    expect(reworkLaunch(settings, bounced(), followup, all)).toBe(followup)
    // Needs a spec first: the spec lane.
    expect(reworkLaunch(settings, bounced({ readiness: 'needs_spec' }), options, all)).toBe(options)
  })

  it('startForTask plans the resume of the implementer', async () => {
    const h = harness()
    h.tasks.set('TASK-1', bounced())
    const plan = vi.fn(h.ports.planLaunch)
    h.ports.planLaunch = plan
    await createSessionLifecycle(h.ports).startForTask('TASK-1', { withPrompt: true })
    expect(plan.mock.calls[0]?.[2]).toMatchObject({
      resume: 'saved-chat',
      provider: 'claude',
      withPrompt: true,
      promptPreface: REWORK_PREFACE
    })
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

  it('refuses a launch whose CLI is missing before writing anything', async () => {
    const h = harness()
    h.ports.ensureAgentCli = async () => {
      throw new Error('Claude Code (`claude`) was not found by Git Bash.')
    }
    await expect(createSessionLifecycle(h.ports).startForTask('TASK-1')).rejects.toThrow(
      'was not found'
    )
    expect(h.calls).toEqual([])
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

  it('sends a Codex helper thread to the subagent folder and marks a new turn there', () => {
    const h = harness()
    const lifecycle = createSessionLifecycle(h.ports)
    lifecycle.recordCodexUpdate({
      taskId: 'default:TASK-1',
      event: 'SubagentStart',
      subagent: { id: 'h1', label: 'Juniper' }
    })
    lifecycle.recordCodexUpdate({
      taskId: 'default:TASK-1',
      event: 'UserPromptSubmit',
      turnStarted: true
    })
    expect(h.calls).toEqual([
      'subagent default:TASK-1 SubagentStart h1',
      'notifyAgents',
      'event default:TASK-1 UserPromptSubmit',
      'subagent default:TASK-1 UserPromptSubmit',
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
    expect(plan.mock.calls[0]?.[2]).toMatchObject({
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

describe('Request changes delivery', () => {
  const MESSAGE =
    'Review of styr/TASK-1 against main: 1 comment in 1 file.\n\nsrc/a.ts\n- src/a.ts:1'

  it('prompts a live, waiting agent through its inbox, without a new tab', async () => {
    const h = harness()
    h.sessions.push(session())
    h.agentState.value = 'waiting'
    h.inbox.listens = true
    const lifecycle = createSessionLifecycle(h.ports)
    expect(lifecycle.reviewRoute('TASK-1').route).toBe('now')
    await expect(lifecycle.deliverReview('TASK-1', MESSAGE)).resolves.toMatchObject({
      route: 'now'
    })
    expect(h.calls).toEqual([`prompt s1 ${MESSAGE}`])
    expect(h.writes).toEqual([])
  })

  it('says a working agent queues it, and types it when there is no inbox', async () => {
    const h = harness()
    h.sessions.push(session())
    h.agentState.value = 'working'
    const lifecycle = createSessionLifecycle(h.ports)
    await expect(lifecycle.deliverReview('TASK-1', MESSAGE)).resolves.toMatchObject({
      route: 'queued'
    })
    expect(h.calls.some((call) => call.startsWith('prompt'))).toBe(false)
    expect(h.writes).toEqual([`s1:\x1b[200~${MESSAGE.replace(/\n/g, '\r')}\x1b[201~`, 's1:\r'])
  })

  it('types it when the inbox refuses it', async () => {
    const h = harness()
    h.sessions.push(session())
    h.inbox.listens = true
    h.inbox.takes = false
    await createSessionLifecycle(h.ports).deliverReview('TASK-1', MESSAGE)
    expect(h.writes).toHaveLength(2)
  })

  it('fails when the terminal closes before the Enter', async () => {
    const h = harness()
    h.sessions.push(session())
    const lifecycle = createSessionLifecycle(h.ports)
    const sent = lifecycle.deliverReview('TASK-1', MESSAGE)
    h.sessions.length = 0
    await expect(sent).rejects.toThrow(/closed/)
    expect(h.writes).toHaveLength(1)
  })

  it('resumes the task’s chat with the message as the whole prompt', async () => {
    const h = harness()
    h.tasks.set(
      'TASK-1',
      task({ status: 'in_review', agentSession: { provider: 'claude', id: 'saved-chat' } })
    )
    const lifecycle = createSessionLifecycle(h.ports)
    expect(lifecycle.reviewRoute('TASK-1').route).toBe('resume')
    await lifecycle.deliverReview('TASK-1', MESSAGE)
    expect(h.launches).toEqual([
      { resume: 'saved-chat', provider: 'claude', withPrompt: true, prompt: MESSAGE }
    ])
    expect(h.calls).toContain('session TASK-1 claude')
  })

  it('starts the agent on the implement template with the message first when there is no chat', async () => {
    const h = harness()
    h.tasks.set('TASK-1', task({ status: 'in_review' }))
    const lifecycle = createSessionLifecycle(h.ports)
    expect(lifecycle.reviewRoute('TASK-1').route).toBe('fresh')
    await lifecycle.deliverReview('TASK-1', MESSAGE)
    const [options] = h.launches
    expect(options).toMatchObject({ withPrompt: true, promptPreface: MESSAGE })
    expect(options!.templateId).toBe(
      resolveTemplateFor(h.settings, task({ status: 'in_progress' })).id
    )
    expect(options!.templateId).not.toBe(
      resolveTemplateFor(h.settings, task({ status: 'in_review' })).id
    )
    expect(options!.prompt).toBeUndefined()
  })

  it('takes the agent to be running in a shell that reports no prompt', async () => {
    const h = harness()
    h.sessions.push(session())
    h.ports.runtimeState = () => ({ cwd: '/repo' })
    h.tasks.set('TASK-1', task({ agentSession: { provider: 'claude', id: 'saved-chat' } }))
    expect(createSessionLifecycle(h.ports).reviewRoute('TASK-1').route).toBe('now')
  })

  it('reuses a live terminal whose agent quit, typing the resume at its shell', async () => {
    const h = harness()
    h.sessions.push(session())
    h.running.value = null
    h.tasks.set('TASK-1', task({ agentSession: { provider: 'claude', id: 'saved-chat' } }))
    const lifecycle = createSessionLifecycle(h.ports)
    expect(lifecycle.reviewRoute('TASK-1').route).toBe('resume')
    await lifecycle.deliverReview('TASK-1', MESSAGE)
    expect(h.calls.some((call) => call.startsWith('session'))).toBe(false)
    expect(h.writes).toEqual([`s1:${syntaxFor('posix').cd('/repo')}\r`, 's1:agent\r'])
  })
})
