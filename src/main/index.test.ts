import { describe, expect, it, vi } from 'vitest'

/**
 * Pins the start-up order in `index.ts` with a call log: every module it starts is faked, and
 * each fake only records that it ran. Handlers must be registered before the window loads (a
 * renderer request would otherwise find no handler), and Auto-run's start-up grace must begin
 * after the initial index sync (its first pass reads the index).
 */

const calls: string[] = []
const record =
  (name: string) =>
  (..._args: unknown[]): undefined => {
    calls.push(name)
    return undefined
  }

let ready!: () => void
const whenReady = new Promise<void>((resolve) => (ready = resolve))

vi.mock('electron', () => {
  class BrowserWindow {
    static getAllWindows = (): BrowserWindow[] => []
    webContents = { setWindowOpenHandler: record('window:openHandler') }
    constructor() {
      calls.push('window:create')
    }
    on = record('window:on')
    loadURL = async (): Promise<void> => record('window:load')()
    loadFile = async (): Promise<void> => record('window:load')()
  }
  return {
    app: {
      whenReady: () => whenReady,
      setName: record('app:setName'),
      setAppUserModelId: record('app:setAppUserModelId'),
      on: (event: string) => calls.push(`app:on ${event}`),
      focus: record('app:focus'),
      quit: record('app:quit')
    },
    BrowserWindow,
    Menu: { setApplicationMenu: record('installAppMenu'), buildFromTemplate: () => ({}) },
    shell: { openExternal: async () => {} }
  }
})
vi.mock('@core/settingsStore.js', () => ({ tasksDir: record('tasksDir') }))
vi.mock('@core/settingsMigration.js', () => ({ migrateLegacySettings: record('migrateSettings') }))
vi.mock('./ipc.js', () => ({
  broadcast: record('broadcast'),
  checkForMergedWork: record('checkForMergedWork'),
  markAgentExited: record('markAgentExited'),
  notifyAgentsChanged: record('notifyAgentsChanged'),
  notifyTasksChanged: record('notifyTasksChanged'),
  registerIpcHandlers: record('registerIpcHandlers'),
  startAutoDispatch: record('startAutoDispatch'),
  switchWorkspace: record('switchWorkspace')
}))
vi.mock('./taskIndex.js', () => ({
  closeIndex: record('closeIndex'),
  syncIndex: record('syncIndex')
}))
vi.mock('./terminal/terminalEngines.js', () => ({
  registerTerminalEngines: () => {
    calls.push('registerTerminalEngines')
    return { detachAll: () => {} }
  }
}))
vi.mock('./terminal/ptyManager.js', () => ({
  killAllSessions: record('killAllSessions'),
  onTerminalData: record('onTerminalData'),
  onTerminalExit: record('onTerminalExit'),
  onTerminalRuntimeState: record('onTerminalRuntimeState'),
  sessionTask: () => undefined
}))
vi.mock('./watcher.js', () => ({
  startWatching: record('startWatching'),
  startWatchingAgents: record('startWatchingAgents'),
  stopWatching: async () => {}
}))
vi.mock('./appIcon.js', () => ({ linuxIconPath: () => '' }))
vi.mock('./mcpEntry.js', () => ({ syncAppImageMcp: record('syncAppImageMcp') }))
vi.mock('./tray.js', () => ({
  createTray: record('createTray'),
  destroyTray: record('destroyTray')
}))
vi.mock('./updater.js', () => ({ initUpdater: record('initUpdater') }))
vi.mock('./usage.js', () => ({ forgetContext: () => {}, initUsage: record('initUsage') }))

describe('start-up order', () => {
  it('runs the ready sequence in a fixed order', async () => {
    await import('./index.js')
    const beforeReady = [...calls]
    ready()
    await vi.waitFor(() => expect(calls).toContain('initUsage'))
    const startup = calls
      .slice(beforeReady.length)
      .filter((call) => !call.startsWith('app:on') && !call.startsWith('app:set'))

    expect(beforeReady).toEqual(['app:on window-all-closed', 'app:on before-quit'])
    expect(startup).toEqual([
      'migrateSettings',
      'syncAppImageMcp',
      'tasksDir',
      'syncIndex',
      'registerIpcHandlers',
      'startAutoDispatch',
      'installAppMenu',
      'onTerminalData',
      'registerTerminalEngines',
      'onTerminalRuntimeState',
      'onTerminalExit',
      'createTray',
      'startWatching',
      'startWatchingAgents',
      'notifyAgentsChanged',
      'window:create',
      'window:on',
      'window:openHandler',
      'window:load',
      'initUpdater',
      'initUsage'
    ])
  })

  it('registers the handlers before the window loads and starts Auto-run after the first sync', () => {
    const at = (name: string): number => calls.indexOf(name)
    expect(at('registerIpcHandlers')).toBeGreaterThan(-1)
    expect(at('registerIpcHandlers')).toBeLessThan(at('window:load'))
    expect(at('syncIndex')).toBeLessThan(at('startAutoDispatch'))
    // The window's first paint reads the activity rollup that this first notify computes.
    expect(at('notifyAgentsChanged')).toBeLessThan(at('window:create'))
  })
})
