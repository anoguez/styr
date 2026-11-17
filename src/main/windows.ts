import { join } from 'node:path'
import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron'
import { linuxIconPath } from './appIcon.js'
import { openHandler } from './windowSecurity.js'
import { watchFullscreen } from './windowFullscreen.js'

/**
 * Every Styr window, the main one and each detached terminal: opaque, its title bar hidden under
 * the renderer's header, and the same sandboxed renderer and preload. `size` is all that differs.
 */
export function styrWindowOptions(
  size: Pick<
    BrowserWindowConstructorOptions,
    'width' | 'height' | 'minWidth' | 'minHeight' | 'x' | 'y'
  >
): BrowserWindowConstructorOptions {
  return {
    ...size,
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
  }
}

/** Shows the window once painted, follows full screen and loads the renderer at `hash`. */
export function loadStyrWindow(window: BrowserWindow, hash?: string): void {
  window.on('ready-to-show', () => window.show())
  watchFullscreen(window)
  window.webContents.setWindowOpenHandler(openHandler((url) => void shell.openExternal(url)))
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    if (hash) url.hash = hash
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }
}

let main: BrowserWindow | null = null

/**
 * The board's window. Detached terminals are windows too, so "the window" is never the first of
 * `getAllWindows()`: the tray, the dock, the updater and activation all mean this one.
 */
export function mainWindow(): BrowserWindow | null {
  return main && !main.isDestroyed() ? main : null
}

export function setMainWindow(window: BrowserWindow): void {
  main = window
  window.on('closed', () => {
    if (main === window) main = null
  })
}
