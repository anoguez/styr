import { BrowserWindow, screen } from 'electron'
import {
  createDetachedTerminals,
  diskBoundsStore,
  MIN_DETACHED_SIZE,
  type Bounds
} from '@host/detachedTerminals.js'
import { electronHost } from './electronHost.js'
import { loadStyrWindow, mainWindow, styrWindowOptions } from './windows.js'

/**
 * A terminal tab in its own window (`@host/detachedTerminals.ts` holds the rules). The window loads
 * the same renderer with `#detached=<id>`, which draws only that terminal (`DetachedTerminal.tsx`).
 */
export const detachedTerminals = createDetachedTerminals<BrowserWindow>({
  open(sessionId, bounds) {
    const window = new BrowserWindow(
      styrWindowOptions({
        ...bounds,
        minWidth: MIN_DETACHED_SIZE.width,
        minHeight: MIN_DETACHED_SIZE.height
      })
    )
    // Read on `close`: once `closed` fires the window is gone and has no bounds left to read.
    let last: Bounds | undefined
    window.on('close', () => {
      if (!window.isMinimized() && !window.isFullScreen()) last = window.getNormalBounds()
    })
    window.on('closed', () => detachedTerminals.closed(sessionId, window, last))
    loadStyrWindow(window, `detached=${encodeURIComponent(sessionId)}`)
    return window
  },
  focus(window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  },
  close: (window) => window.close(),
  displays: () => screen.getAllDisplays().map((display) => display.workArea),
  mainBounds: () => mainWindow()?.getNormalBounds(),
  store: diskBoundsStore,
  broadcast: (channel, payload) => electronHost.broadcast(channel, payload)
})
