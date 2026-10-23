import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoDispatchPorts } from '@core/autoDispatchRunner.js'
import type { Task, TerminalSessionInfo } from '@core/types.js'

/**
 * Characterisation tests for the ordering the main process depends on. `ipc.ts` is loaded for
 * real over a temporary storage folder; only Electron, the SQLite index, the watchers, the
 * terminals and other native or networked pieces are faked, and each fake writes to one call log
 * so a test can pin the order of the side effects. These pin today's behaviour: a change that
 * fails one should be deliberate, not a side effect of a refactor.
 */

const calls: string[] = []
const log = (entry: string): void => {
  calls.push(entry)
}

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => {
  const window = {
    webContents: { send: (channel: string) => log(`broadcast ${channel}`) }
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

/** The SQLite index, kept in memory: a sync re-reads the active workspace's task files. */
vi.mock('./taskIndex.js', async () => {
  const store = await import('@core/taskStore.js')
  let rows: Task[] = []
  return {
    syncIndex: () => {
      log(`syncIndex ${activeId()}`)
      rows = store.listTasks()
    },
    closeIndex: () => {
      log('closeIndex')
      rows = []
    },
    queryTasks: () => rows,
    findTask: (id: string) => rows.find((task) => task.id === id)
  }
})

vi.mock('./watcher.js', () => ({
  startWatching: () => log(`startWatching ${activeId()}`),
  startWatchingAgents: () => log(`startWatchingAgents ${activeId()}`)
}))
vi.mock('./tray.js', () => ({ updateTray: () => log('updateTray') }))
vi.mock('./landing.js', () => ({
  settleLandedTasks: async () => {
    log('settleLandedTasks')
    return landingWrites.shift() ?? false
  }
}))
vi.mock('./sourceSync.js', () => ({
  initSourceSync: () => {},
  linkTask: () => {},
  listSourceTargets: () => [],
  observeTasks: () => log('observeTasks'),
  refreshTask: () => {},
  previewSource: () => {},
  resetSourceObserver: () => log('resetSources'),
  restartSourcePolling: () => log('restartSourcePolling'),
  sourceStates: () => [],
  syncSource: () => {},
  unlinkTask: () => {}
}))
vi.mock('./diagnostics.js', () => ({
  recordNotifyDuration: () => log('recordNotifyDuration'),
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
  killSession: () => {},
  listSessions: () => sessions,
  resizeSession: () => {},
  sessionBacklog: () => '',
  terminalRuntimeState: () => undefined,
  writeToSession: () => {}
}))
vi.mock('./codexMonitor.js', () => ({
  CodexMonitor: class {
    release(): void {}
    expect(): Promise<void> {
      return Promise.resolve()
    }
    watch(): Promise<void> {
      return Promise.resolve()
    }
  },
  prepareCodex: async () => undefined
}))
vi.mock('./usage.js', () => ({ publishAgentConversation: () => {} }))
vi.mock('./agentCli.js', () => ({ agentCliStatus: () => ({}), ensureAgentCli: async () => {} }))
vi.mock('./mcpEntry.js', () => ({ mcpEntry: () => '/mcp.mjs' }))

/** Auto-run for real, with its requests and passes written to the call log. */
vi.mock('@core/autoDispatchRunner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@core/autoDispatchRunner.js')>()
  return {
    ...real,
    createAutoDispatch: (ports: AutoDispatchPorts) => {
      const runner = real.createAutoDispatch({
        ...ports,
        snapshot: (skip) => {
          log('autoRun:pass')
          return ports.snapshot(skip)
        }
      })
      return {
        ...runner,
        request: () => {
          log('autoRun:request')
          runner.request()
        }
      }
    }
  }
})

const sessions: TerminalSessionInfo[] = []
const landingWrites: boolean[] = []

/** The workspace in force when a fake ran, read through the settings module loaded below. */
const activeId = (): string => settingsModule.loadSettings().activeWorkspaceId

const home = mkdtempSync(join(tmpdir(), 'styr-ipc-test-'))
const storageDir = join(home, 'Styr')
mkdirSync(join(home, 'config'), { recursive: true })
writeFileSync(join(home, 'config', 'config.json'), JSON.stringify({ storageDir }))
process.env.STYR_HOME = join(home, 'config')

const settingsModule = await import('@core/settingsStore.js')
const { loadSettings, saveWorkspaceSettings, saveGlobalSettings } = settingsModule
const { pinnedWorkspaceId, pathsInWorkspace } = await import('@core/config.js')
const { createWorkspace, readWorkspaceTasks } = await import('@core/workspaces.js')
const { PLAN_RUN_TAG } = await import('@core/planning.js')
const { createTask } = await import('@core/taskStore.js')
const { readAgentStatus, statusFilePath } = await import('@core/agentStore.js')
const { globalSettingsFor, workspaceSettingsFor } = await import('@core/types.js')
const ipc = await import('./ipc.js')
ipc.registerIpcHandlers()

const invoke = (channel: string, ...args: unknown[]): unknown =>
  handlers.get(channel)!({ sender: {} }, ...args)

function activate(id: string): void {
  saveGlobalSettings({ ...globalSettingsFor(loadSettings()), activeWorkspaceId: id })
}

const seed = workspaceSettingsFor(loadSettings())
createWorkspace(loadSettings(), 'Alpha', seed)
createWorkspace(loadSettings(), 'Beta', seed)
for (const id of ['default', 'alpha', 'beta']) {
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
  vi.useRealTimers()
  calls.length = 0
  sessions.length = 0
  landingWrites.length = 0
})

describe('notifyTasksChanged', () => {
  it('re-indexes, broadcasts once and arms one Auto-run request, in that order', () => {
    invoke('tasks:update', 'TASK-0001', { title: 'Renamed' })
    expect(calls).toEqual([
      'syncIndex default',
      'observeTasks',
      'recordNotifyDuration',
      'broadcast tasks:changed',
      'settleLandedTasks',
      'autoRun:request'
    ])
  })

  it('never waits for the landing pass, and re-indexes again once it wrote a task file', async () => {
    landingWrites.push(true)
    ipc.notifyTasksChanged()
    const NOTIFY = [
      'syncIndex default',
      'observeTasks',
      'recordNotifyDuration',
      'broadcast tasks:changed',
      'settleLandedTasks',
      'autoRun:request'
    ]
    expect(calls).toEqual(NOTIFY)
    await new Promise((resolve) => setImmediate(resolve))
    expect(calls).toEqual([...NOTIFY, ...NOTIFY])
  })

  it('a burst of task writes is one Auto-run pass', async () => {
    saveWorkspaceSettings({ ...loadSettings(), autoDispatch: true }, 'default')
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 5; i += 1) invoke('tasks:update', 'TASK-0001', { title: `Burst ${i}` })
      expect(calls.filter((call) => call === 'broadcast tasks:changed')).toHaveLength(5)
      expect(calls).not.toContain('autoRun:pass')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(calls.filter((call) => call === 'autoRun:pass')).toHaveLength(1)
    } finally {
      saveWorkspaceSettings({ ...loadSettings(), autoDispatch: false }, 'default')
    }
  })

  it('runs synchronously: the board is re-indexed and broadcast before the call returns', () => {
    const result: unknown = ipc.notifyTasksChanged()
    expect(result).toBeUndefined()
    expect(calls).toContain('broadcast tasks:changed')
  })
})

describe('notifyAgentsChanged', () => {
  it('broadcasts the agents, updates the tray, broadcasts the rollup, then requests Auto-run', () => {
    ipc.notifyAgentsChanged()
    expect(calls).toEqual([
      'broadcast agents:changed',
      'updateTray',
      'broadcast workspaces:activity',
      'autoRun:request'
    ])
  })
})

describe('switchWorkspace', () => {
  it('runs to completion synchronously, so A→B→A ends on A', () => {
    activate('alpha')
    ipc.notifyTasksChanged()
    calls.length = 0

    expect(ipc.switchWorkspace('beta')).toBeUndefined()
    expect(ipc.switchWorkspace('alpha')).toBeUndefined()

    const repointed = calls.filter((call) =>
      /^(closeIndex|syncIndex|startWatching|startWatchingAgents) ?/.test(call)
    )
    expect(repointed).toEqual([
      'closeIndex',
      'startWatching beta',
      'startWatchingAgents beta',
      'syncIndex beta',
      'closeIndex',
      'startWatching alpha',
      'startWatchingAgents alpha',
      'syncIndex alpha'
    ])
    expect(loadSettings().activeWorkspaceId).toBe('alpha')
    expect((invoke('tasks:list', {}) as Task[]).map((task) => task.title)).toEqual([
      'First in alpha'
    ])
    activate('default')
    ipc.notifyTasksChanged()
  })

  it('closes the index before restarting the watchers, and broadcasts the change last', () => {
    ipc.switchWorkspace('beta')
    ipc.switchWorkspace('default')
    const first = calls.slice(0, calls.indexOf('broadcast workspaces:changed') + 1)
    expect(first).toEqual([
      'resetSources',
      'restartSourcePolling',
      'closeIndex',
      'startWatching beta',
      'startWatchingAgents beta',
      'syncIndex beta',
      'observeTasks',
      'recordNotifyDuration',
      'broadcast tasks:changed',
      'settleLandedTasks',
      'autoRun:request',
      'broadcast agents:changed',
      'updateTray',
      'broadcast workspaces:activity',
      'autoRun:request',
      'broadcast settings:changed',
      'broadcast workspaces:changed'
    ])
  })
})

describe('inOtherWorkspace', () => {
  it('pins the workspace only while the work runs', () => {
    let during: string | undefined
    const result = ipc.inOtherWorkspace('beta', () => {
      during = pinnedWorkspaceId()
      return loadSettings().activeWorkspaceId
    })
    expect(during).toBe('beta')
    expect(result).toBe('beta')
    expect(pinnedWorkspaceId()).toBeUndefined()
  })

  it('clears the pin when the work throws', () => {
    expect(() =>
      ipc.inOtherWorkspace('beta', () => {
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(pinnedWorkspaceId()).toBeUndefined()
  })

  it('never holds the pin across an await: async work resumes unpinned', async () => {
    let afterAwait: string | undefined = 'unset'
    const pending = ipc.inOtherWorkspace('beta', async () => {
      await Promise.resolve()
      afterAwait = pinnedWorkspaceId()
    })
    expect(pinnedWorkspaceId()).toBeUndefined()
    await pending
    expect(afterAwait).toBeUndefined()
  })
})

describe('markAgentExited', () => {
  const file = (workspaceId: string, taskId: string): string =>
    statusFilePath(pathsInWorkspace(loadSettings(), workspaceId), taskId)
  const state = (workspaceId: string, taskId: string) =>
    readAgentStatus(pathsInWorkspace(loadSettings(), workspaceId), taskId)?.state

  /** A hook writes `at` in whole seconds; the main process writes milliseconds. */
  function hookWrites(workspaceId: string, taskId: string, event: string, at: string): void {
    writeFileSync(
      file(workspaceId, taskId),
      `${JSON.stringify({ taskId, event, at, payload: { session_id: 'x' } })}\n`
    )
  }

  it('writes the exit over an earlier hook record, then refreshes the agents', () => {
    hookWrites('default', 'TASK-0001', 'PreToolUse', '2020-01-01T00:00:00Z')
    expect(state('default', 'TASK-0001')).toBe('working')
    ipc.markAgentExited('TASK-0001', 'default')
    expect(state('default', 'TASK-0001')).toBe('exited')
    expect(calls).toContain('broadcast agents:changed')
  })

  /**
   * Today there is no timestamp comparison: the exit and the hook share one file and the last
   * write wins. A hook that lands after the exit replaces it even though its second-precision
   * `at` parses earlier than the exit's milliseconds.
   */
  it('is replaced by any hook record written after it, whatever the timestamps say', () => {
    ipc.markAgentExited('TASK-0001', 'default')
    const exitAt = readAgentStatus(loadSettings(), 'TASK-0001')!.at
    const sameSecond = `${exitAt.slice(0, 19)}Z`
    expect(Date.parse(sameSecond)).toBeLessThanOrEqual(Date.parse(exitAt))
    hookWrites('default', 'TASK-0001', 'Stop', sameSecond)
    expect(state('default', 'TASK-0001')).toBe('idle')
  })

  it('writes into the named workspace, not the active one', () => {
    hookWrites('beta', 'TASK-0001', 'PreToolUse', '2020-01-01T00:00:00Z')
    ipc.markAgentExited('TASK-0001', 'beta')
    expect(state('beta', 'TASK-0001')).toBe('exited')
    expect(state('default', 'TASK-0001')).not.toBe('exited')
    expect(pinnedWorkspaceId()).toBeUndefined()
  })

  it('archives a finished planning run inside its own workspace and leaves no pin behind', () => {
    activate('beta')
    const run = createTask({ title: 'Plan', tags: [PLAN_RUN_TAG], orchestrate: false })
    activate('default')
    calls.length = 0
    ipc.markAgentExited(run.id, 'beta')
    expect(pinnedWorkspaceId()).toBeUndefined()
    expect(
      readWorkspaceTasks(loadSettings(), 'beta').find((task) => task.id === run.id)
    ).toMatchObject({ archivedAt: expect.any(String) })
    expect(calls).toEqual([
      'syncIndex default',
      'observeTasks',
      'recordNotifyDuration',
      'broadcast tasks:changed',
      'settleLandedTasks',
      'autoRun:request',
      'broadcast agents:changed',
      'updateTray',
      'broadcast workspaces:activity',
      'autoRun:request'
    ])
  })
})

describe('terminal:launchAgent', () => {
  it('returns the live session of a task that has one and spawns nothing', async () => {
    const live = {
      id: 'live',
      taskId: 'TASK-0001',
      workspaceId: 'default'
    } as TerminalSessionInfo
    sessions.push(live)
    await expect(invoke('terminal:launchAgent', 'TASK-0001')).resolves.toBe(live)
    expect(calls.filter((call) => call.startsWith('createSession'))).toEqual([])
  })

  it('spawns for the same task id when only another workspace has a session for it', async () => {
    sessions.push({ id: 'other', taskId: 'TASK-0001', workspaceId: 'beta' } as TerminalSessionInfo)
    const session = (await invoke('terminal:launchAgent', 'TASK-0001')) as TerminalSessionInfo
    expect(session.id).not.toBe('other')
    expect(calls.filter((call) => call.startsWith('createSession'))).toEqual([
      'createSession default TASK-0001'
    ])
  })

  it('two launches at once share one spawn', async () => {
    const [first, second] = (await Promise.all([
      invoke('terminal:launchAgent', 'TASK-0001'),
      invoke('terminal:launchAgent', 'TASK-0001')
    ])) as TerminalSessionInfo[]
    expect(first).toBe(second)
    expect(calls.filter((call) => call.startsWith('createSession'))).toHaveLength(1)
  })
})
