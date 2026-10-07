import { join } from 'node:path'
import { app, BrowserWindow, Menu, shell } from 'electron'
import { tasksDir } from '@core/settingsStore.js'
import { migrateLegacySettings } from '@core/settingsMigration.js'
import {
  broadcast,
  markAgentExited,
  notifyAgentsChanged,
  notifyTasksChanged,
  registerIpcHandlers,
  switchWorkspace
} from './ipc.js'
import { closeIndex, syncIndex } from './taskIndex.js'
import {
  killAllSessions,
  onTerminalData,
  onTerminalExit,
  onTerminalRuntimeState,
  sessionTask
} from './terminal/ptyManager.js'
import { startWatching, startWatchingAgents, stopWatching } from './watcher.js'
import { createTray, destroyTray } from './tray.js'
import { initUpdater } from './updater.js'
import { initUsage } from './usage.js'

/**
 * Electron's default menu binds ⌘W to Close Window, and a menu accelerator is handled before the
 * renderer sees the key — so ⌘W closed the whole window instead of reaching the shortcut system.
 * The standard menu is rebuilt with that one accelerator removed; closing the window stays
 * available from the menu and the traffic light.
 */
function installAppMenu(): void {
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
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 15 },
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  window.on('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

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
  migrateSettings()
  tasksDir()
  syncIndex()
  registerIpcHandlers()
  installAppMenu()

  onTerminalData((id, output) => broadcast('terminal:data', { id, ...output }))
  onTerminalRuntimeState((state) => broadcast('terminal:runtimeState', state))
  onTerminalExit((id, exitCode) => {
    const task = sessionTask(id)
    broadcast('terminal:exit', { id, exitCode })
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
    onQuit: () => app.quit()
  })

  startWatching(() => notifyTasksChanged())
  startWatchingAgents(() => notifyAgentsChanged())
  notifyAgentsChanged()

  createWindow()
  initUpdater()
  initUsage()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  destroyTray()
  killAllSessions()
  void stopWatching()
  closeIndex()
})
