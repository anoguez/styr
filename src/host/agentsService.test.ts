import { beforeEach, describe, expect, it } from 'vitest'
import { shippedSettings } from '@core/config.js'
import type { AgentConversation } from '@core/agentConversation.js'
import type { AgentStatus } from '@core/agentState.js'
import { PLAN_RUN_TAG } from '@core/planning.js'
import type { ThreadUpdate } from '@core/providers/codexProtocol.js'
import type { Settings, Task, TerminalSessionInfo, WorkspacesActivity } from '@core/types.js'
import {
  createAgentsService,
  type AgentsService,
  type AgentsServicePorts
} from './agentsService.js'

function task(extra: Partial<Task> = {}): Task {
  return {
    id: 'TASK-1',
    title: 'First',
    status: 'in_progress',
    tags: [],
    sessions: [],
    repoPath: '/repo',
    ...extra
  } as unknown as Task
}

const status = (extra: Partial<AgentStatus> = {}): AgentStatus => ({
  taskId: 'TASK-1',
  state: 'working',
  at: '2026-01-01T00:00:00Z',
  ...extra
})

interface Harness {
  ports: AgentsServicePorts
  settings: Settings
  calls: string[]
  /** What every broadcast sent, by channel, newest last. */
  sent: { channel: string; payload: unknown }[]
  rows: Task[]
  /** Tasks of a workspace other than the default, read while it is pinned. */
  otherRows: Record<string, Task[]>
  pinned?: string
  statuses: AgentStatus[]
  background: AgentStatus[]
  sessions: TerminalSessionInfo[]
  trays: { statuses: AgentStatus[]; titles: Map<string, string> }[]
  published: string[]
  monitor?: {
    onUpdate: (update: ThreadUpdate) => void
    onConversation: (key: string, conversation: AgentConversation) => void
  }
}

function harness(): Harness {
  const h = {
    settings: { ...shippedSettings(), activeWorkspaceId: 'default' } as Settings,
    calls: [],
    sent: [],
    rows: [task()],
    otherRows: {},
    statuses: [status()],
    background: [],
    sessions: [],
    trays: [],
    published: []
  } as unknown as Harness
  const { calls } = h
  h.ports = {
    broadcast: (channel, payload) => {
      calls.push(`broadcast ${channel}`)
      h.sent.push({ channel, payload })
    },
    store: {
      loadSettings: () => h.settings,
      readAgentStatuses: () => h.statuses,
      recordAgentEvent: (ws, id, event) => calls.push(`event ${ws}:${id} ${event}`),
      recordSubagentEvent: (ws, id, event) => calls.push(`subagent ${ws}:${id} ${event}`),
      clearAgentStatus: (_settings, id) => calls.push(`clear ${id}`),
      listWorkspaces: () => [
        { id: 'default', name: 'Default' },
        { id: 'beta', name: 'Beta' }
      ],
      readBackgroundAgents: (_settings, activeId) => {
        calls.push(`background except ${activeId}`)
        return {
          statuses: h.background,
          titles: new Map(h.background.map((s) => [`${s.workspaceId}:${s.taskId}`, 'In beta'])),
          awaitingReview: new Set()
        }
      },
      writeHandoff: () => '/handoff.md'
    },
    git: {
      branch: (cwd) => (cwd === '/repo' ? 'main' : undefined),
      baseBranch: () => 'main',
      workingTree: () => ({ clean: true }) as never
    },
    tasks: {
      query: () => h.rows,
      findTask: (id) => h.rows.find((row) => row.id === id),
      getTask: (id) => ((h.pinned && h.otherRows[h.pinned]) || h.rows).find((row) => row.id === id),
      updateTask: (id) => calls.push(`update ${id}`),
      addNote: () => undefined,
      createTask: (draft) => task({ ...draft, id: 'TASK-2' } as Partial<Task>),
      setArchived: (id, archived) => calls.push(`archive ${id} ${archived}`),
      removeAgent: (id) => calls.push(`removeAgent ${id}`)
    },
    notifyTasks: () => calls.push('notifyTasks'),
    pinWorkspace: (ws, work) => {
      calls.push(`pin ${ws}`)
      h.pinned = ws
      try {
        return work()
      } finally {
        h.pinned = undefined
        calls.push('unpin')
      }
    },
    terminals: {
      createSession: (options) => {
        calls.push(`createSession ${options.workspaceId} ${options.taskId}`)
        return { ...options, id: 'new' } as TerminalSessionInfo
      },
      findSessionByTask: (id, ws) =>
        h.sessions.find((session) => session.taskId === id && session.workspaceId === ws),
      listSessions: () => h.sessions,
      killSession: (id) => calls.push(`kill ${id}`),
      writeToSession: () => {},
      runtimeState: () => undefined
    },
    createMonitor: (onUpdate, onConversation) => {
      calls.push('createMonitor')
      h.monitor = { onUpdate, onConversation }
      return {
        expect: async () => {},
        watch: async () => {},
        release: (key) => calls.push(`release ${key}`),
        submitPrompt: async (key, text) => void calls.push(`submit ${key} ${text}`),
        answerApproval: async (key, id, allow) => void calls.push(`answer ${key} ${id} ${allow}`)
      }
    },
    publishConversation: (sessionId, _conversation, submit, answer) => {
      h.published.push(sessionId)
      void submit('hi')
      void answer('a1', 'allow')
    },
    prompts: { promptInbox: () => false, promptAgent: async () => false },
    ensureAgentCli: async (provider) => void calls.push(`ensureCli ${provider}`),
    prepareCodex: async () => {
      calls.push('prepareCodex')
      return '/sock'
    },
    planLaunch: (_settings, _task, options) => ({
      provider: options.provider ?? 'claude',
      command: 'agent --resume',
      cwd: '/repo',
      extraDirs: [],
      extraWorktrees: [],
      sessionId: options.resume ?? 'fresh',
      resumed: true,
      prompt: undefined,
      templateId: undefined
    }),
    updateTray: (statuses, titles) => {
      calls.push('updateTray')
      h.trays.push({ statuses, titles })
    },
    requestAutoRun: () => calls.push('autoRun')
  }
  return h
}

let h: Harness
let service: AgentsService

beforeEach(() => {
  h = harness()
  service = createAgentsService(h.ports)
  h.calls.length = 0
})

/** One `notifyAgentsChanged`, as the call log records it. */
const REFRESH = [
  'broadcast agents:changed',
  'background except default',
  'updateTray',
  'broadcast workspaces:activity',
  'autoRun'
]

describe('creation', () => {
  it('creates the Codex monitor once, with the service', () => {
    const fresh = harness()
    createAgentsService(fresh.ports)
    expect(fresh.calls).toEqual(['createMonitor'])
  })
})

describe('agentStatuses', () => {
  it("tags each record with the branch of its task's working directory", () => {
    h.rows = [task(), task({ id: 'TASK-2', worktreePath: '/elsewhere' })]
    h.statuses = [status(), status({ taskId: 'TASK-2' }), status({ taskId: 'TASK-9' })]
    expect(service.agentStatuses().map((row) => row.branch)).toEqual(['main', undefined, undefined])
  })
})

describe('notifyAgentsChanged', () => {
  it('broadcasts the agents, updates the tray, broadcasts the rollup, then requests Auto-run', () => {
    service.notifyAgentsChanged()
    expect(h.calls).toEqual(REFRESH)
    expect(h.sent[0]!.payload).toEqual([{ ...status(), branch: 'main' }])
  })

  it('gives the tray the active agents named by workspace, then the background ones', () => {
    h.background = [status({ state: 'waiting', workspaceId: 'beta', workspaceName: 'Beta' })]
    service.notifyAgentsChanged()
    const [tray] = h.trays
    expect(tray!.statuses.map((row) => [row.workspaceId, row.workspaceName, row.state])).toEqual([
      ['default', 'Default', 'working'],
      ['beta', 'Beta', 'waiting']
    ])
    expect([...tray!.titles]).toEqual([
      ['default:TASK-1', 'First'],
      ['beta:TASK-1', 'In beta']
    ])
  })

  it('leaves the agent of a Done or archived task out of the tray, not out of the sidebar', () => {
    h.rows = [task({ status: 'done' })]
    service.notifyAgentsChanged()
    expect(h.trays[0]!.statuses).toEqual([])
    expect(h.sent[0]!.payload).toHaveLength(1)
  })

  it('rolls the tray model up per workspace, and activity() serves the last rollup', () => {
    expect(service.activity()).toEqual({ activeId: 'default', byWorkspace: {} })
    h.background = [status({ state: 'waiting', workspaceId: 'beta', workspaceName: 'Beta' })]
    service.notifyAgentsChanged()
    const rollup = h.sent.find((entry) => entry.channel === 'workspaces:activity')!
      .payload as WorkspacesActivity
    expect(rollup.activeId).toBe('default')
    expect(rollup.byWorkspace.default).toMatchObject({ top: 'working' })
    expect(rollup.byWorkspace.beta).toMatchObject({ top: 'waiting' })
    expect(service.activity()).toBe(rollup)
  })
})

describe('the Codex monitor', () => {
  it('records an update into the workspace its key names, then refreshes', () => {
    h.monitor!.onUpdate({ taskId: 'beta:TASK-1', event: 'UserPromptSubmit' })
    expect(h.calls).toEqual(['event beta:TASK-1 UserPromptSubmit', ...REFRESH])
  })

  it("publishes a conversation to that workspace's session, answering through the monitor", () => {
    h.sessions = [{ id: 'b1', taskId: 'TASK-1', workspaceId: 'beta' } as TerminalSessionInfo]
    const conversation = { at: 'now', working: false, messages: [] } as AgentConversation
    h.monitor!.onConversation('default:TASK-1', conversation)
    expect(h.published).toEqual([])
    h.monitor!.onConversation('beta:TASK-1', conversation)
    expect(h.published).toEqual(['b1'])
    expect(h.calls).toEqual(['submit beta:TASK-1 hi', 'answer beta:TASK-1 a1 true'])
  })
})

describe('markAgentExited', () => {
  it('releases the monitor, records the exit, then refreshes', () => {
    service.markAgentExited('TASK-1', 'beta')
    expect(h.calls).toEqual([
      'release beta:TASK-1',
      'event beta:TASK-1 TerminalExit',
      'pin beta',
      'unpin',
      ...REFRESH
    ])
  })

  it('defaults to the active workspace', () => {
    service.markAgentExited('TASK-1')
    expect(h.calls[1]).toBe('event default:TASK-1 TerminalExit')
  })

  it('archives a finished planning run inside its workspace before the refresh', () => {
    h.rows = [task({ tags: [PLAN_RUN_TAG] })]
    service.markAgentExited('TASK-1', 'beta')
    expect(h.calls.slice(0, 6)).toEqual([
      'release beta:TASK-1',
      'event beta:TASK-1 TerminalExit',
      'pin beta',
      'archive TASK-1 true',
      'unpin',
      'notifyTasks'
    ])
    expect(h.calls.slice(6)).toEqual(REFRESH)
  })
})

describe('markAgentExited archives Ask agent chats', () => {
  const ask = (extra: Partial<Task> = {}) => task({ tags: ['ask'], ...extra })
  const archived = () => h.calls.includes('archive TASK-1 true')

  it('archives an in-progress ask, then notifies once', () => {
    h.rows = [ask()]
    service.markAgentExited('TASK-1', 'default')
    expect(archived()).toBe(true)
    expect(h.calls.filter((call) => call === 'notifyTasks')).toHaveLength(1)
  })

  it.each(['backlog', 'in_review', 'done'] as const)('keeps an ask in %s', (status) => {
    h.rows = [ask({ status })]
    service.markAgentExited('TASK-1', 'default')
    expect(archived()).toBe(false)
  })

  it('keeps an ask whose tag was removed', () => {
    h.rows = [task()]
    service.markAgentExited('TASK-1', 'default')
    expect(archived()).toBe(false)
  })

  it('keeps an already archived ask', () => {
    h.rows = [ask({ archivedAt: '2026-01-01T00:00:00Z' })]
    service.markAgentExited('TASK-1', 'default')
    expect(archived()).toBe(false)
  })

  it('keeps asks when autoArchiveAsk is off', () => {
    h.settings = { ...h.settings, autoArchiveAsk: false }
    h.rows = [ask()]
    service.markAgentExited('TASK-1', 'default')
    expect(archived()).toBe(false)
  })

  it("never reads another workspace's task with the same id", () => {
    h.rows = [ask()]
    h.otherRows = { beta: [ask({ status: 'in_review' })] }
    service.markAgentExited('TASK-1', 'beta')
    expect(archived()).toBe(false)
    h.otherRows = { beta: [ask()] }
    h.rows = [ask({ status: 'done' })]
    service.markAgentExited('TASK-1', 'beta')
    expect(h.calls).toContain('pin beta')
    expect(archived()).toBe(true)
  })
})

describe('remove', () => {
  it('kills the live terminal, releases the monitor, clears the status, then the task file', () => {
    h.sessions = [{ id: 'live', taskId: 'TASK-1', workspaceId: 'default' } as TerminalSessionInfo]
    service.remove('TASK-1')
    expect(h.calls).toEqual([
      'kill live',
      'release default:TASK-1',
      'clear TASK-1',
      'removeAgent TASK-1'
    ])
  })

  it("swallows the removed agent's terminal exit once, writing no status", () => {
    h.sessions = [{ id: 'live', taskId: 'TASK-1', workspaceId: 'default' } as TerminalSessionInfo]
    service.remove('TASK-1')
    h.calls.length = 0
    service.markAgentExited('TASK-1', 'default')
    expect(h.calls).toEqual(['release default:TASK-1', ...REFRESH])
    h.calls.length = 0
    service.markAgentExited('TASK-1', 'default')
    expect(h.calls).toContain('event default:TASK-1 TerminalExit')
  })

  it('without a live terminal, a later exit is recorded', () => {
    service.remove('TASK-1')
    h.calls.length = 0
    service.markAgentExited('TASK-1', 'default')
    expect(h.calls).toContain('event default:TASK-1 TerminalExit')
  })
})

describe('resume', () => {
  it('checks the CLI, then replays the chat in the active workspace', async () => {
    const session = await service.resume('TASK-1', 'chat-1')
    expect(h.calls).toEqual(['ensureCli claude', 'createSession default TASK-1'])
    expect(session).toMatchObject({
      replay: true,
      command: 'agent --resume',
      env: { STYR_TASK_ID: 'TASK-1', STYR_WORKSPACE_ID: 'default', STYR_SESSION_ID: 'chat-1' }
    })
  })

  it("prepares the Codex daemon for a Codex chat, by the chat's own provider", async () => {
    h.rows = [task({ sessions: [{ id: 'chat-1', provider: 'codex' }] as Task['sessions'] })]
    await service.resume('TASK-1', 'chat-1')
    expect(h.calls).toEqual(['ensureCli codex', 'prepareCodex', 'createSession default TASK-1'])
  })

  it('refuses a task that is not on the board', async () => {
    await expect(service.resume('TASK-9', 'chat-1')).rejects.toThrow('Task TASK-9 not found')
  })
})

describe('launch', () => {
  it('returns the live session of a task and spawns nothing', async () => {
    const live = { id: 'live', taskId: 'TASK-1', workspaceId: 'default' } as TerminalSessionInfo
    h.sessions = [live]
    await expect(service.launch('TASK-1')).resolves.toBe(live)
    expect(h.calls.filter((call) => call.startsWith('createSession'))).toEqual([])
  })
})

describe('previewPrompt', () => {
  it('renders the prompt a launch would send, from the task on the board', () => {
    h.rows = [task({ contextFiles: [], blockedBy: [], activity: [], questions: [] })]
    expect(service.previewPrompt('TASK-1')).toContain('TASK-1')
    expect(() => service.previewPrompt('TASK-9')).toThrow('Task TASK-9 not found')
  })
})
