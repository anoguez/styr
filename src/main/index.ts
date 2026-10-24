import { join } from 'node:path'
import { app, BrowserWindow, Menu, shell } from 'electron'
import { loadSettings, tasksDir } from '@core/settingsStore.js'
import { listWorkspaces } from '@core/workspaces.js'
import type { AutoDispatchState } from '@core/types.js'
import { migrateLegacySettings } from '@core/settingsMigration.js'
import {
  autoRunState,
  broadcast,
  checkMergedOnFocus,
  freezeTerminalLayout,
  markAgentExited,
  notifyAgentsChanged,
  notifyTasksChanged,
  registerIpcHandlers,
  sendWindowCommand,
  startAutoDispatch,
  startAutoRunFromTray,
  startRemoteWorkspaces,
  stopRemoteWorkspaces,
  switchWorkspace
} from './ipc.js'
import { closeIndex, syncIndex } from './taskIndex.js'
import { registerTerminalEngines } from './terminal/terminalEngines.js'
import { terminalBroadcasts } from '@host/terminals/terminalsService.js'
import {
  killAllSessions,
  onTerminalData,
  onTerminalExit,
  onTerminalRuntimeState,
  sessionTask
} from './terminal/ptyManager.js'
import { startWatching, startWatchingAgents, stopWatching } from './watcher.js'
import { linuxIconPath } from './appIcon.js'
import { guardNavigation, openHandler } from './windowSecurity.js'
import { syncAppImageMcp } from './mcpEntry.js'
import { onBroadcast } from './electronHost.js'
import { createTray, destroyTray, setTrayAutoRun, watchWindow } from './tray.js'
import { initUpdater } from './updater.js'
import { registerAccessHandlers, startNetworkAccess, stopNetworkAccess } from './networkAccess.js'
import { forgetContext, initUsage } from './usage.js'

/**
 * Electron's default menu binds ⌘W to Close Window, and a menu accelerator is handled before the
 * renderer sees the key — so ⌘W closed the whole window instead of reaching the shortcut system.
 * The standard menu is rebuilt with that one accelerator removed; closing the window stays
 * available from the menu and the traffic light.
 */
function installAppMenu(): void {
  if (process.platform !== 'darwin') return installWindowsMenu()
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'fileMenu', submenu: [{ role: 'close', accelerator: 'Shift+CmdOrCtrl+W' }] },
    { role: 'editMenu' },
    {
      // The stock View menu binds ⌘R to Reload, which would swallow the terminal's Retry shortcut
      // and reload the window out from under every running session. Reload moves to ⌥⌘R.
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: 'Alt+CmdOrCtrl+R' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Windows and Linux have no app menu, and their edit roles bind bare Ctrl+C/V/X/A/Z — keys the terminal needs
 * (Ctrl+C interrupts). The menu bar is never shown under the overlay title bar, so the menu exists
 * only for its accelerators: window close, reload, devtools and zoom. Force Reload is left out
 * because its Ctrl+Shift+R is the terminal's Retry on Windows, and it would kill every session.
 */
function installWindowsMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'View',
      submenu: [
        { role: 'close', accelerator: 'Shift+Ctrl+W' },
        { role: 'reload', accelerator: 'Alt+Ctrl+R' },
        { role: 'toggleDevTools' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** The active workspace's name, remote stubs included, for the tray's Auto-run row. */
function activeWorkspaceName(): string {
  const settings = loadSettings()
  const active = listWorkspaces(settings).find(
    (workspace) => workspace.id === settings.activeWorkspaceId
  )
  return active?.name ?? 'this workspace'
}

/** Bumped by every read, so a slow answer about the workspace switched away from is dropped. */
let autoRunRead = 0

/** Re-reads Auto-run for the tray; a board that cannot answer (a host is down) drops the section. */
function refreshTrayAutoRun(): void {
  const read = ++autoRunRead
  autoRunState().then(
    (state) =>
      read === autoRunRead && setTrayAutoRun({ workspaceName: activeWorkspaceName(), state }),
    () => read === autoRunRead && setTrayAutoRun(null)
  )
}

/** The tray follows what the windows are told, as `useAutoDispatch` does in the renderer. */
function followBroadcastsInTray(): void {
  onBroadcast((channel, payload) => {
    switch (channel) {
      case 'orchestrate:autoState':
        autoRunRead++
        return setTrayAutoRun({
          workspaceName: activeWorkspaceName(),
          state: payload as AutoDispatchState
        })
      case 'settings:changed':
      case 'workspaces:changed':
      case 'remote:state':
        return refreshTrayAutoRun()
    }
  })
}

function showWindow(): void {
  const [existing] = BrowserWindow.getAllWindows()
  const window = existing ?? createWindow()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  app.focus({ steal: true })
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 15 } }
      : {
          // Native minimise/maximise/close drawn over the renderer's 44px header; the renderer
          // recolours them to the theme through `app:titleBarColors`.
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#0f1c27', symbolColor: '#97a7b4', height: 44 },
          // Windows takes the icon from the .exe; Linux has to be given one.
          ...(process.platform === 'linux' ? { icon: linuxIconPath() } : {})
        }),
    backgroundColor: '#0b0d12',
    webPreferences: {
      // A sandboxed preload is one CommonJS script (`electron.vite.config.ts`).
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer shows what remote hosts wrote: whatever got into it stays in Chromium's
      // sandbox, with only `window.api` (`docs/architecture/remote.md`, Trust boundary).
      sandbox: true
    }
  })

  window.on('ready-to-show', () => window.show())
  watchWindow(window)
  window.webContents.setWindowOpenHandler(openHandler((url) => void shell.openExternal(url)))

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

/**
 * A failed migration must not stop the app: the legacy values stay in the config, `loadSettings`
 * keeps layering them in, and the next start tries again.
 */
function migrateSettings(): void {
  try {
    migrateLegacySettings()
  } catch (error) {
    console.error('Styr could not move settings into the workspace folders:', error)
  }
}

app.whenReady().then(() => {
  app.setName('Styr')
  // Windows shows toast notifications only for an app with an AppUserModelID; this one matches
  // the `appId` the installer registers its shortcut under.
  if (process.platform === 'win32') app.setAppUserModelId('com.andersonnoguez.styr')
  // Every page Styr shows stays on its own document and opens only web links outside.
  app.on('web-contents-created', (_event, contents) =>
    guardNavigation(contents, (url) => void shell.openExternal(url))
  )
  migrateSettings()
  syncAppImageMcp()
  tasksDir()
  syncIndex()
  registerIpcHandlers()
  registerAccessHandlers()
  startRemoteWorkspaces()
  startAutoDispatch()
  installAppMenu()

  const terminalEvents = terminalBroadcasts(broadcast)
  onTerminalData(terminalEvents.data)
  const nativeTerminals = registerTerminalEngines(broadcast)
  app.on('before-quit', () => nativeTerminals.detachAll())
  onTerminalRuntimeState(terminalEvents.runtimeState)
  onTerminalExit((id, exitCode) => {
    forgetContext(id)
    const task = sessionTask(id)
    terminalEvents.exit(id, exitCode)
    if (task) markAgentExited(task.taskId, task.workspaceId)
  })
  createTray({
    onShowWindow: showWindow,
    onActivateTask: (taskId, workspaceId) => {
      showWindow()
      // An agent from another workspace is activated by opening that workspace first; the
      // renderer holds the request until the board it names has loaded.
      if (workspaceId) {
        try {
          switchWorkspace(workspaceId)
        } catch {
          return
        }
      }
      broadcast('tasks:activate', taskId)
    },
    onCommand: (command) => {
      showWindow()
      sendWindowCommand(command)
    },
    onStartAutoRun: () =>
      void startAutoRunFromTray().catch((error: unknown) =>
        console.error('Styr could not start Auto-run:', error)
      ),
    onQuit: () => app.quit(),
    shortcuts: () => loadSettings().shortcuts
  })
  followBroadcastsInTray()
  refreshTrayAutoRun()

  startWatching(() => notifyTasksChanged())
  startWatchingAgents(() => notifyAgentsChanged())
  notifyAgentsChanged()

  createWindow()
  initUpdater()
  initUsage()
  startNetworkAccess()

  // You merge a PR in the browser and come back: that is when to look for it. Throttled per repo.
  app.on('browser-window-focus', () => checkMergedOnFocus())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  destroyTray()
  stopRemoteWorkspaces()
  stopNetworkAccess()
  freezeTerminalLayout()
  killAllSessions()
  void stopWatching()
  closeIndex()
})
