import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '@core/agentState.js'
import type { AgentConversation } from '@core/agentConversation.js'
import type { ThreadUpdate } from '@core/providers/codexProtocol.js'
import type { TerminalSessionInfo, WorkspacesActivity } from '@core/types.js'

/**
 * Characterisation tests for the agent wiring in `ipc.ts`: what the tray and the workspace
 * switcher are given, removing a live agent, the Codex monitor's callbacks and resuming a chat.
 * Like `ipc.test.ts`, `ipc.ts` runs for real over a temporary storage folder with Electron, the
 * index, the watchers, the terminals and the Codex daemon faked.
 */

const calls: string[] = []
const log = (entry: string): void => {
  calls.push(entry)
}
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const broadcasts: { channel: string; payload: unknown }[] = []
const trays: { statuses: AgentStatus[]; titles: Map<string, string> }[] = []
const published: { sessionId: string; conversation: AgentConversation }[] = []
const sessions: TerminalSessionInfo[] = []

/** The callbacks `ipc.ts` handed the Codex monitor it created. */
let monitor:
  | {
      onUpdate: (update: ThreadUpdate) => void
      onConversation: (key: string, conversation: AgentConversation) => void
      released: string[]
    }
  | undefined

vi.mock('electron', () => {
  const window = {
    webContents: {
      send: (channel: string, payload: unknown) => broadcasts.push({ channel, payload })
    }
  }
  return {
    app: { isPackaged: false, getVersion: () => '0.0.0' },
    BrowserWindow: { getAllWindows: () => [window], fromWebContents: () => null },
    dialog: {},
    ipcMain: {
      handle: (channel: string, run: (...args: unknown[]) => unknown) => handlers.set(channel, run),
      on: (channel: string, run: (...args: unknown[]) => unknown) => handlers.set(channel, run)
    },
    Notification: { isSupported: () => false },
    shell: { trashItem: async () => {} }
  }
})
vi.mock('./taskIndex.js', async () => {
  const store = await import('@core/taskStore.js')
  let rows: import('@core/types.js').Task[] = []
  return {
    syncIndex: () => {
      rows = store.listTasks()
    },
    closeIndex: () => {
      rows = []
    },
    queryTasks: () => rows,
    findTask: (id: string) => rows.find((task) => task.id === id)
  }
})
vi.mock('./watcher.js', () => ({ startWatching: () => {}, startWatchingAgents: () => {} }))
vi.mock('./tray.js', () => ({
  updateTray: (statuses: AgentStatus[], titles: Map<string, string>) =>
    trays.push({ statuses, titles })
}))
vi.mock('./landing.js', () => ({ settleLandedTasks: async () => false }))
vi.mock('./sourceSync.js', () => ({
  initSourceSync: () => {},
  linkTask: () => {},
  listSourceTargets: () => [],
  observeTasks: () => {},
  refreshTask: () => {},
  previewSource: () => {},
  resetSourceObserver: () => {},
  restartSourcePolling: () => {},
  sourceStates: () => [],
  syncSource: () => {},
  unlinkTask: () => {}
}))
vi.mock('./diagnostics.js', () => ({
  recordNotifyDuration: () => {},
  stopSampling: () => {},
  takeSnapshot: () => ({})
}))
vi.mock('./terminal/terminalEngines.js', () => ({ terminalEngineDiagnostics: () => undefined }))
vi.mock('./terminal/ptyManager.js', () => ({
  onTerminalCreated: () => {},
  onTerminalExit: () => {},
  createSession: (options: Omit<TerminalSessionInfo, 'id'>) => {
    log(`createSession ${options.workspaceId} ${options.taskId}`)
    const session = { ...options, id: `s${sessions.length + 1}` } as TerminalSessionInfo
    sessions.push(session)
    return session
  },
  findSessionByTask: (taskId: string, workspaceId: string) =>
    sessions.find((session) => session.taskId === taskId && session.workspaceId === workspaceId),
  killSession: (id: string) => log(`killSession ${id}`),
  listSessions: () => sessions,
  resizeSession: () => {},
  sessionBacklog: () => '',
  terminalRuntimeState: () => undefined,
  writeToSession: () => {}
}))
vi.mock('./codexMonitor.js', () => ({
  CodexMonitor: class {
    constructor(
      onUpdate: (update: ThreadUpdate) => void,
      onConversation: (key: string, conversation: AgentConversation) => void
    ) {
      log('new CodexMonitor')
      monitor = { onUpdate, onConversation, released: [] }
    }
    release(key: string): void {
      monitor!.released.push(key)
    }
    expect(): Promise<void> {
      return Promise.resolve()
    }
    watch(): Promise<void> {
      return Promise.resolve()
    }
  },
  prepareCodex: async () => '/codex.sock'
}))
vi.mock('./usage.js', () => ({
  publishAgentConversation: (sessionId: string, conversation: AgentConversation) =>
    published.push({ sessionId, conversation })
}))
vi.mock('./agentCli.js', () => ({ agentCliStatus: () => ({}), ensureAgentCli: async () => {} }))
vi.mock('./mcpEntry.js', () => ({ mcpEntry: () => '/mcp.mjs' }))

const home = mkdtempSync(join(tmpdir(), 'styr-agents-test-'))
const storageDir = join(home, 'Styr')
mkdirSync(join(home, 'config'), { recursive: true })
writeFileSync(join(home, 'config', 'config.json'), JSON.stringify({ storageDir }))
process.env.STYR_HOME = join(home, 'config')

const { loadSettings, saveGlobalSettings } = await import('@core/settingsStore.js')
const { pathsInWorkspace } = await import('@core/config.js')
const { createWorkspace } = await import('@core/workspaces.js')
const { createTask, updateTask } = await import('@core/taskStore.js')
const { readAgentStatus, recordAgentEvent } = await import('@core/agentStore.js')
const { globalSettingsFor, workspaceSettingsFor } = await import('@core/types.js')
const ipc = await import('./ipc.js')
ipc.registerIpcHandlers()

const invoke = (channel: string, ...args: unknown[]): unknown =>
  handlers.get(channel)!({ sender: {} }, ...args)

function activate(id: string): void {
  saveGlobalSettings({ ...globalSettingsFor(loadSettings()), activeWorkspaceId: id })
}

const scoped = (workspaceId: string) => pathsInWorkspace(loadSettings(), workspaceId)
const state = (workspaceId: string, taskId: string) =>
  readAgentStatus(scoped(workspaceId), taskId)?.state

createWorkspace(loadSettings(), 'Beta', workspaceSettingsFor(loadSettings()))
for (const id of ['default', 'beta']) {
  activate(id)
  createTask({ title: `First in ${id}`, orchestrate: false })
}
activate('default')
ipc.notifyTasksChanged()

afterAll(() => {
  delete process.env.STYR_HOME
  rmSync(home, { recursive: true, force: true })
})

beforeEach(() => {
  calls.length = 0
  broadcasts.length = 0
  trays.length = 0
  published.length = 0
  sessions.length = 0
  monitor!.released.length = 0
})

describe('the Codex monitor', () => {
  it('is created once, when ipc.ts loads', () => {
    expect(monitor).toBeDefined()
  })

  it('records an update into the workspace its key names, then refreshes the agents', () => {
    monitor!.onUpdate({ taskId: 'beta:TASK-0001', event: 'UserPromptSubmit' })
    expect(state('beta', 'TASK-0001')).toBe('working')
    expect(broadcasts.map((entry) => entry.channel)).toEqual([
      'agents:changed',
      'workspaces:activity'
    ])
  })

  it('publishes a conversation to the session of that workspace and task only', () => {
    sessions.push({ id: 'b1', taskId: 'TASK-0001', workspaceId: 'beta' } as TerminalSessionInfo)
    const conversation = { at: 'now', working: false, messages: [] } as AgentConversation
    monitor!.onConversation('default:TASK-0001', conversation)
    expect(published).toEqual([])
    monitor!.onConversation('beta:TASK-0001', conversation)
    expect(published).toEqual([{ sessionId: 'b1', conversation }])
  })
})

describe('notifyAgentsChanged', () => {
  it('gives the tray the active agents, then the background ones, with their titles', () => {
    recordAgentEvent(scoped('default'), 'TASK-0001', 'PreToolUse')
    recordAgentEvent(scoped('beta'), 'TASK-0001', 'Notification')
    ipc.notifyAgentsChanged()

    const [tray] = trays
    expect(trays).toHaveLength(1)
    expect(
      tray!.statuses.map((status) => [status.workspaceId, status.taskId, status.state])
    ).toEqual([
      ['default', 'TASK-0001', 'working'],
      ['beta', 'TASK-0001', 'waiting']
    ])
    expect(tray!.statuses.map((status) => status.workspaceName)).toEqual(['Default', 'Beta'])
    expect([...tray!.titles.values()]).toEqual(['First in default', 'First in beta'])

    const agents = broadcasts.find((entry) => entry.channel === 'agents:changed')!
    expect((agents.payload as AgentStatus[]).map((status) => status.taskId)).toEqual(['TASK-0001'])
  })

  it('leaves a Done task out of the tray but still broadcasts its agent', () => {
    recordAgentEvent(scoped('default'), 'TASK-0001', 'PreToolUse')
    updateTask('TASK-0001', { status: 'done' })
    ipc.notifyTasksChanged()
    broadcasts.length = 0
    trays.length = 0
    ipc.notifyAgentsChanged()
    expect(trays[0]!.statuses.map((status) => status.workspaceId)).toEqual(['beta'])
    const agents = broadcasts.find((entry) => entry.channel === 'agents:changed')!
    expect(agents.payload as AgentStatus[]).toHaveLength(1)
    updateTask('TASK-0001', { status: 'backlog' })
    ipc.notifyTasksChanged()
  })

  it('broadcasts the per-workspace rollup, and workspaces:activity serves the last one', () => {
    recordAgentEvent(scoped('default'), 'TASK-0001', 'PreToolUse')
    recordAgentEvent(scoped('beta'), 'TASK-0001', 'Notification')
    ipc.notifyAgentsChanged()
    const rollup = broadcasts.find((entry) => entry.channel === 'workspaces:activity')!
      .payload as WorkspacesActivity
    expect(rollup.activeId).toBe('default')
    expect(rollup.byWorkspace.default).toMatchObject({ top: 'working', review: 0 })
    expect(rollup.byWorkspace.beta).toMatchObject({ top: 'waiting', review: 0 })
    expect(rollup.byWorkspace.beta!.counts.waiting).toBe(1)
    expect(invoke('workspaces:activity')).toBe(rollup)
  })
})

describe('agents:remove', () => {
  it('kills the live terminal, releases the monitor and clears the status', () => {
    recordAgentEvent(scoped('default'), 'TASK-0001', 'PreToolUse')
    sessions.push({
      id: 'live',
      taskId: 'TASK-0001',
      workspaceId: 'default'
    } as TerminalSessionInfo)
    invoke('agents:remove', 'TASK-0001')
    expect(calls).toEqual(['killSession live'])
    expect(monitor!.released).toEqual(['default:TASK-0001'])
    expect(state('default', 'TASK-0001')).toBeUndefined()
    expect(broadcasts.map((entry) => entry.channel)).toContain('agents:changed')
  })

  it("keeps the removed agent's terminal exit from writing a status back, once", () => {
    sessions.push({
      id: 'live',
      taskId: 'TASK-0001',
      workspaceId: 'default'
    } as TerminalSessionInfo)
    invoke('agents:remove', 'TASK-0001')
    broadcasts.length = 0
    ipc.markAgentExited('TASK-0001', 'default')
    expect(state('default', 'TASK-0001')).toBeUndefined()
    expect(broadcasts.map((entry) => entry.channel)).toEqual([
      'agents:changed',
      'workspaces:activity'
    ])
    ipc.markAgentExited('TASK-0001', 'default')
    expect(state('default', 'TASK-0001')).toBe('exited')
  })

  it('only marks a removal when there was a live terminal', () => {
    invoke('agents:remove', 'TASK-0001')
    ipc.markAgentExited('TASK-0001', 'default')
    expect(state('default', 'TASK-0001')).toBe('exited')
  })
})

describe('terminal:resumeSession', () => {
  /** No transcript exists on disk here, so the plan falls back to a fresh chat id. */
  it('replays the chat in a new session of the active workspace', async () => {
    const session = (await invoke(
      'terminal:resumeSession',
      'TASK-0001',
      'chat-1'
    )) as TerminalSessionInfo
    expect(calls).toEqual(['createSession default TASK-0001'])
    expect(session).toMatchObject({
      taskId: 'TASK-0001',
      workspaceId: 'default',
      replay: true,
      env: {
        STYR_TASK_ID: 'TASK-0001',
        STYR_WORKSPACE_ID: 'default',
        STYR_SESSION_ID: expect.any(String)
      }
    })
  })

  it('refuses a task that is not on the board', async () => {
    await expect(invoke('terminal:resumeSession', 'TASK-9999', 'chat-1')).rejects.toThrow(
      'Task TASK-9999 not found'
    )
  })
})
