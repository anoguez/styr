import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('@core/config.js', () => ({ configDir: () => home.dir }))

import {
  DEFAULT_DETACHED_SIZE,
  createDetachedTerminals,
  diskBoundsStore,
  parseBounds,
  placeDetachedWindow,
  type Bounds,
  type DetachedWindowPorts
} from './detachedTerminals.js'

const LAPTOP: Bounds = { x: 0, y: 25, width: 1440, height: 875 }
const MONITOR: Bounds = { x: 1440, y: 0, width: 2560, height: 1440 }

describe('parseBounds', () => {
  it('reads a saved place', () => {
    expect(parseBounds('{"x":10,"y":20,"width":800,"height":500}')).toEqual({
      x: 10,
      y: 20,
      width: 800,
      height: 500
    })
  })

  it('ignores a missing, broken or nonsensical file', () => {
    expect(parseBounds(undefined)).toBeUndefined()
    expect(parseBounds('{')).toBeUndefined()
    expect(parseBounds('null')).toBeUndefined()
    expect(parseBounds('{"x":1,"y":2,"width":"wide","height":3}')).toBeUndefined()
    expect(parseBounds('{"x":1,"y":2,"width":0,"height":3}')).toBeUndefined()
  })
})

describe('diskBoundsStore', () => {
  home.dir = join(mkdtempSync(join(tmpdir(), 'styr-detached-')), 'nested')
  afterAll(() => rmSync(join(home.dir, '..'), { recursive: true, force: true }))

  it('reads nothing before a window was ever closed', () => {
    expect(diskBoundsStore.read()).toBeUndefined()
  })

  it('writes the file, creating its folder, and reads it back', () => {
    diskBoundsStore.write('{"x":1}')
    expect(readFileSync(join(home.dir, 'detached-terminal.json'), 'utf8')).toBe('{"x":1}')
    expect(diskBoundsStore.read()).toBe('{"x":1}')
  })
})

describe('placeDetachedWindow', () => {
  it('opens the default size near the main window when nothing is remembered', () => {
    const main = { x: 100, y: 100, width: 1200, height: 800 }
    expect(placeDetachedWindow(undefined, [LAPTOP], main)).toEqual({
      ...DEFAULT_DETACHED_SIZE,
      x: 148,
      y: 148
    })
  })

  it('keeps a remembered place on a second monitor', () => {
    const saved = { x: 2000, y: 200, width: 1000, height: 700 }
    expect(placeDetachedWindow(saved, [LAPTOP, MONITOR], LAPTOP)).toEqual(saved)
  })

  it('moves a window whose monitor is gone onto the main window display', () => {
    const saved = { x: 2000, y: 200, width: 1000, height: 700 }
    expect(placeDetachedWindow(saved, [LAPTOP], LAPTOP)).toEqual({
      x: 440,
      y: 200,
      width: 1000,
      height: 700
    })
  })

  it('picks the display the main window is on when the remembered one is gone', () => {
    const saved = { x: 9000, y: 9000, width: 800, height: 500 }
    const main = { x: 1600, y: 100, width: 1200, height: 800 }
    expect(placeDetachedWindow(saved, [LAPTOP, MONITOR], main)).toEqual({
      x: 3200,
      y: 940,
      width: 800,
      height: 500
    })
  })

  it('shrinks a window bigger than the display it lands on', () => {
    const saved = { x: 1500, y: 0, width: 2400, height: 1400 }
    expect(placeDetachedWindow(saved, [LAPTOP], undefined)).toEqual(LAPTOP)
  })

  it('pulls back a window hanging off an edge', () => {
    const saved = { x: 1200, y: 600, width: 900, height: 600 }
    expect(placeDetachedWindow(saved, [LAPTOP], LAPTOP)).toEqual({
      x: 540,
      y: 300,
      width: 900,
      height: 600
    })
  })
})

interface FakeWindow {
  sessionId: string
  bounds: Bounds
  closed: boolean
  focused: number
}

function harness(saved?: string) {
  const broadcasts: unknown[] = []
  const written: string[] = []
  const opened: FakeWindow[] = []
  const ports: DetachedWindowPorts<FakeWindow> = {
    open: (sessionId, bounds) => {
      const window = { sessionId, bounds, closed: false, focused: 0 }
      opened.push(window)
      return window
    },
    focus: (window) => void window.focused++,
    close: (window) => {
      window.closed = true
      // Electron reports `closed` after the window goes; the glue passes its last bounds.
      service.closed(window.sessionId, window, window.bounds)
    },
    displays: () => [LAPTOP],
    mainBounds: () => ({ x: 0, y: 25, width: 1200, height: 800 }),
    store: { read: () => saved, write: (text) => void written.push(text) },
    broadcast: (channel, payload) => void broadcasts.push([channel, payload])
  }
  const service = createDetachedTerminals(ports)
  return { service, broadcasts, written, opened }
}

describe('createDetachedTerminals', () => {
  it('opens a window for a session and tells the windows', () => {
    const { service, broadcasts, opened } = harness()
    expect(service.detach('abc')).toBe('opened')
    expect(opened).toHaveLength(1)
    expect(opened[0]!.bounds).toEqual({ ...DEFAULT_DETACHED_SIZE, x: 48, y: 73 })
    expect(service.list()).toEqual(['abc'])
    expect(service.isDetached('abc')).toBe(true)
    expect(service.windowFor('abc')).toBe(opened[0])
    expect(service.windowFor('other')).toBeUndefined()
    expect(broadcasts).toEqual([['terminal:detachedChanged', ['abc']]])
  })

  it('focuses the open window instead of opening a second one', () => {
    const { service, opened } = harness()
    service.detach('abc')
    expect(service.detach('abc')).toBe('focused')
    expect(opened).toHaveLength(1)
    expect(opened[0]!.focused).toBe(1)
  })

  it('docks by closing the window, remembering where it was', () => {
    const { service, broadcasts, written, opened } = harness()
    service.detach('abc')
    opened[0]!.bounds = { x: 10, y: 40, width: 700, height: 500 }
    service.dock('abc')
    expect(opened[0]!.closed).toBe(true)
    expect(service.list()).toEqual([])
    expect(JSON.parse(written[0]!)).toEqual({ x: 10, y: 40, width: 700, height: 500 })
    expect(broadcasts.at(-1)).toEqual(['terminal:detachedChanged', []])
  })

  it('opens the next window where the last one was', () => {
    const { service, opened } = harness('{"x":300,"y":200,"width":800,"height":500}')
    service.detach('abc')
    expect(opened[0]!.bounds).toEqual({ x: 300, y: 200, width: 800, height: 500 })
  })

  it('ignores a closed report from a window that was already replaced', () => {
    const { service, opened } = harness()
    service.detach('abc')
    const stale = { ...opened[0]! }
    service.closed('abc', stale)
    expect(service.isDetached('abc')).toBe(true)
  })

  it('docks every window when the main window closes', () => {
    const { service, opened } = harness()
    service.detach('a')
    service.detach('b')
    service.dockAll()
    expect(opened.every((window) => window.closed)).toBe(true)
    expect(service.list()).toEqual([])
  })

  it('docking a session with no window does nothing', () => {
    const { service, broadcasts } = harness()
    service.dock('nope')
    expect(broadcasts).toEqual([])
  })
})
