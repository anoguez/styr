import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { tasksDir } from '@core/config.js'
import {
  broadcast,
  markAgentExited,
  notifyAgentsChanged,
  notifyTasksChanged,
  registerIpcHandlers
} from './ipc.js'
import { closeIndex, syncIndex } from './taskIndex.js'
import {
  killAllSessions,
  onTerminalData,
  onTerminalExit,
  sessionTaskId
} from './terminal/ptyManager.js'
import { startWatching, startWatchingAgents, stopWatching } from './watcher.js'
import { createTray, destroyTray } from './tray.js'
import { initUpdater } from './updater.js'

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

  onTerminalData((id, data, sequence) => broadcast('terminal:data', { id, data, sequence }))
  onTerminalExit((id, exitCode) => {
    const taskId = sessionTaskId(id)
    broadcast('terminal:exit', { id, exitCode })
    if (taskId) markAgentExited(taskId)
  })
  createTray({
    onShowWindow: showWindow,
    onActivateTask: (taskId) => {
      showWindow()
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
