import { join } from 'node:path'
import { app, BrowserWindow, Menu, shell } from 'electron'
import { tasksDir } from '@core/config.js'
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
  sessionTask
} from './terminal/ptyManager.js'
import { startWatching, startWatchingAgents, stopWatching } from './watcher.js'
import { createTray, destroyTray } from './tray.js'
import { initUpdater } from './updater.js'

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
    { role: 'viewMenu' },
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

app.whenReady().then(() => {
  app.setName('Styr')
  tasksDir()
  syncIndex()
  registerIpcHandlers()
  installAppMenu()

  onTerminalData((id, data, sequence) => broadcast('terminal:data', { id, data, sequence }))
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
