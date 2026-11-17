import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configDir } from '@core/config.js'

/**
 * Terminal tabs popped out into their own windows (`docs/architecture/ui.md`, Detached terminals).
 * Detaching moves only where a session is drawn: the PTY, its agent state and its task stay where
 * they are, and the main window keeps the tab in its list (hidden from the strip) so docking puts it
 * back in place. This is the Electron-free part — which window shows which session, and where a new
 * window opens; `src/main/detachedTerminals.ts` implements the window port.
 *
 * Keyed by terminal id: unlike task ids, terminal ids are unique across workspaces and hosts (the
 * same id is what `terminal:data` and `terminal:exit` name).
 */

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export const DEFAULT_DETACHED_SIZE = { width: 900, height: 600 } as const
/** Smallest window the terminal and its header still fit in. */
export const MIN_DETACHED_SIZE = { width: 420, height: 240 } as const
/** How far a new window opens from the main one's corner, when there is no remembered place. */
const CASCADE = 48

/** The last detached window's place, machine-local (`~/.styr/detached-terminal.json`). */
export interface BoundsStore {
  read(): string | undefined
  write(text: string): void
}

export const diskBoundsStore: BoundsStore = {
  read: () => {
    try {
      return readFileSync(join(configDir(), 'detached-terminal.json'), 'utf8')
    } catch {
      return undefined
    }
  },
  write: (text) => {
    const path = join(configDir(), 'detached-terminal.json')
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, path)
  }
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** The remembered bounds, or undefined for a missing or hand-broken file. */
export function parseBounds(text: string | undefined): Bounds | undefined {
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as Partial<Bounds> | null
    if (!value || typeof value !== 'object') return undefined
    const { x, y, width, height } = value
    if (!isNumber(x) || !isNumber(y) || !isNumber(width) || !isNumber(height)) return undefined
    if (width <= 0 || height <= 0) return undefined
    return { x, y, width, height }
  } catch {
    return undefined
  }
}

function overlap(a: Bounds, b: Bounds): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

function fitInto(bounds: Bounds, area: Bounds): Bounds {
  const width = Math.min(Math.max(bounds.width, MIN_DETACHED_SIZE.width), area.width)
  const height = Math.min(Math.max(bounds.height, MIN_DETACHED_SIZE.height), area.height)
  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)
  }
}

/**
 * Where a detached window opens: the remembered place, moved onto the display it overlaps most and
 * shrunk to fit it (a monitor unplugged since is never a window off-screen), or else the default
 * size near the main window's corner. `displays` are the work areas of the connected displays.
 */
export function placeDetachedWindow(
  saved: Bounds | undefined,
  displays: readonly Bounds[],
  main: Bounds | undefined
): Bounds {
  const wanted: Bounds = saved ?? {
    ...DEFAULT_DETACHED_SIZE,
    x: (main?.x ?? 0) + CASCADE,
    y: (main?.y ?? 0) + CASCADE
  }
  if (displays.length === 0) return wanted
  const best = displays.reduce((most, display) =>
    overlap(wanted, display) > overlap(wanted, most) ? display : most
  )
  // Nowhere on screen (a display was removed): the main window's display, else the first one.
  const area =
    overlap(wanted, best) > 0
      ? best
      : (main &&
          displays.reduce((most, display) =>
            overlap(main, display) > overlap(main, most) ? display : most
          )) ||
        displays[0]!
  return fitInto(wanted, area)
}

/** The window operations the service needs; Electron implements them for `BrowserWindow`. */
export interface DetachedWindowPorts<W> {
  /** Opens a window showing `sessionId`; `closed` must be reported when it goes away. */
  open(sessionId: string, bounds: Bounds): W
  /** Brings a window forward, restoring it if minimised. */
  focus(window: W): void
  close(window: W): void
  /** The work areas of the connected displays. */
  displays(): Bounds[]
  /** The main window's bounds, when it is open. */
  mainBounds(): Bounds | undefined
  store: BoundsStore
  broadcast(channel: string, payload?: unknown): void
}

export function createDetachedTerminals<W>(ports: DetachedWindowPorts<W>) {
  const windows = new Map<string, W>()

  const announce = (): void => ports.broadcast('terminal:detachedChanged', [...windows.keys()])

  return {
    /** The sessions shown in their own window. */
    list(): string[] {
      return [...windows.keys()]
    },
    isDetached(sessionId: string): boolean {
      return windows.has(sessionId)
    },
    windowFor(sessionId: string): W | undefined {
      return windows.get(sessionId)
    },
    /**
     * Shows the session in its own window. Detaching one that already has a window focuses it, so
     * the sidebar, the palette and the tray can all just ask for it.
     */
    detach(sessionId: string): 'opened' | 'focused' {
      const existing = windows.get(sessionId)
      if (existing) {
        ports.focus(existing)
        return 'focused'
      }
      const bounds = placeDetachedWindow(
        parseBounds(ports.store.read()),
        ports.displays(),
        ports.mainBounds()
      )
      windows.set(sessionId, ports.open(sessionId, bounds))
      announce()
      return 'opened'
    },
    /** Puts the tab back in the main window: closes its window, which reports `closed`. */
    dock(sessionId: string): void {
      const window = windows.get(sessionId)
      if (window) ports.close(window)
    },
    /**
     * A detached window went away, however it was closed. Its place is remembered for the next one
     * and the main window shows the tab again; the session is never touched.
     */
    closed(sessionId: string, window: W, bounds?: Bounds): void {
      if (windows.get(sessionId) !== window) return
      windows.delete(sessionId)
      if (bounds) {
        try {
          ports.store.write(JSON.stringify(bounds))
        } catch (error) {
          console.error('Styr could not remember where the terminal window was:', error)
        }
      }
      announce()
    },
    /** Docks every tab: the main window is closing, and a quit must never lose one. */
    dockAll(): void {
      for (const window of [...windows.values()]) ports.close(window)
    }
  }
}

export type DetachedTerminals<W> = ReturnType<typeof createDetachedTerminals<W>>
