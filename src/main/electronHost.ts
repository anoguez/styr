import { app, BrowserWindow, dialog, Notification, shell, type WebContents } from 'electron'
import type { AppPaths, HostPorts, WindowPorts } from '@host/ports.js'

/** The host's ports, implemented by Electron for the desktop app. */
export const electronHost: HostPorts = {
  broadcast(channel, payload) {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload)
  },
  notify(title, body) {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  },
  trashItem: (path) => shell.trashItem(path),
  appPaths: {
    get isPackaged() {
      return app.isPackaged
    },
    get version() {
      return app.getVersion()
    },
    get appPath() {
      return app.getAppPath()
    },
    get resourcesPath() {
      return process.resourcesPath
    }
  } satisfies AppPaths
}

/** Window-bound operations act on the window whose renderer sent the request. */
export const electronWindows: WindowPorts<WebContents> = {
  setTitleBarOverlay(caller, colors) {
    BrowserWindow.fromWebContents(caller)?.setTitleBarOverlay(colors)
  },
  async showOpenDialog(caller, options) {
    const parent = BrowserWindow.fromWebContents(caller)
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths
  }
}
