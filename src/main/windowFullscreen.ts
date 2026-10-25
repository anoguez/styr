import type { BrowserWindow } from 'electron'

/**
 * Tells the renderer whether the window is in native full screen (`window:fullscreen`), on every
 * change and after each load so a reload in full screen starts right. macOS hides the traffic lights
 * there, and the header closes the gap they leave.
 */
export function watchFullscreen(window: BrowserWindow): void {
  const send = (full: boolean): void => {
    if (!window.isDestroyed()) window.webContents.send('window:fullscreen', full)
  }
  window.on('enter-full-screen', () => send(true))
  window.on('leave-full-screen', () => send(false))
  window.webContents.on('did-finish-load', () => send(window.isFullScreen()))
}
