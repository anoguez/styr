import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Electron glue for detached terminals: a fake `BrowserWindow` records what the port asks of
 * it, and its events are fired by hand to stand for the user closing or focusing a window.
 */

const state = vi.hoisted(() => ({
  home: '',
  windows: [] as FakeWindow[],
  broadcasts: [] as unknown[][]
}))

type Handler = () => void

class FakeWindow {
  handlers = new Map<string, Handler[]>()
  minimized = false
  fullScreen = false
  destroyed = false
  calls: string[] = []
  loaded: unknown[] = []
  bounds = { x: 10, y: 20, width: 700, height: 400 }
  webContents = { setWindowOpenHandler: () => this.calls.push('openHandler') }
  constructor(public options: Record<string, unknown>) {
    state.windows.push(this)
  }
  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    return this
  }
  emit(event: string): void {
    for (const handler of this.handlers.get(event) ?? []) handler()
  }
  isMinimized = (): boolean => this.minimized
  isFullScreen = (): boolean => this.fullScreen
  isDestroyed = (): boolean => this.destroyed
  getNormalBounds = (): typeof this.bounds => this.bounds
  restore = (): number => this.calls.push('restore')
  show = (): number => this.calls.push('show')
  focus = (): number => this.calls.push('focus')
  close = (): void => {
    this.calls.push('close')
    this.emit('close')
    this.destroyed = true
    this.emit('closed')
  }
  loadURL = async (url: string): Promise<void> => void this.loaded.push(url)
  loadFile = async (file: string, options?: unknown): Promise<void> =>
    void this.loaded.push([file, options])
}

vi.mock('electron', () => ({
  BrowserWindow: FakeWindow,
  screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
  shell: { openExternal: async () => {} }
}))
vi.mock('@core/config.js', () => ({ configDir: () => state.home }))
vi.mock('./electronHost.js', () => ({
  electronHost: { broadcast: (...args: unknown[]) => void state.broadcasts.push(args) }
}))
vi.mock('./appIcon.js', () => ({ linuxIconPath: () => '/icon.png' }))
vi.mock('./windowFullscreen.js', () => ({ watchFullscreen: () => {} }))

delete process.env.ELECTRON_RENDERER_URL
const { detachedTerminals } = await import('./detachedTerminals.js')
const { mainWindow, setMainWindow, styrWindowOptions } = await import('./windows.js')

state.home = mkdtempSync(join(tmpdir(), 'styr-detached-main-'))
afterAll(() => rmSync(state.home, { recursive: true, force: true }))

beforeEach(() => {
  detachedTerminals.dockAll()
  state.windows.length = 0
  state.broadcasts.length = 0
})

describe('detached terminal windows', () => {
  it('opens a sized window on the detached route and announces it', () => {
    expect(detachedTerminals.detach('t 1')).toBe('opened')
    const [window] = state.windows
    expect(window!.options).toMatchObject({ show: false, minWidth: 420, minHeight: 240 })
    expect(window!.loaded[0]).toEqual([
      expect.stringContaining('index.html'),
      { hash: 'detached=t%201' }
    ])
    window!.emit('ready-to-show')
    expect(window!.calls).toContain('show')
    expect(state.broadcasts).toEqual([['terminal:detachedChanged', ['t 1']]])
  })

  it('focuses a minimised window instead of opening another', () => {
    detachedTerminals.detach('t1')
    state.windows[0]!.minimized = true
    expect(detachedTerminals.detach('t1')).toBe('focused')
    expect(state.windows).toHaveLength(1)
    expect(state.windows[0]!.calls).toEqual(expect.arrayContaining(['restore', 'show', 'focus']))
  })

  it('docks by closing the window and opens the next one where it was', () => {
    detachedTerminals.detach('t1')
    state.windows[0]!.bounds = { x: 100, y: 120, width: 640, height: 360 }
    detachedTerminals.dock('t1')
    expect(detachedTerminals.list()).toEqual([])
    expect(state.broadcasts.at(-1)).toEqual(['terminal:detachedChanged', []])

    detachedTerminals.detach('t2')
    expect(state.windows[1]!.options).toMatchObject({ x: 100, y: 120, width: 640, height: 360 })
  })

  it('does not remember the place of a window closed while full screen', () => {
    detachedTerminals.detach('t1')
    state.windows[0]!.bounds = { x: 300, y: 300, width: 500, height: 300 }
    detachedTerminals.dock('t1')
    detachedTerminals.detach('t2')
    state.windows[1]!.fullScreen = true
    state.windows[1]!.bounds = { x: 0, y: 0, width: 1920, height: 1080 }
    detachedTerminals.dock('t2')
    detachedTerminals.detach('t3')
    expect(state.windows[2]!.options).toMatchObject({ x: 300, y: 300 })
  })

  it('opens a first window near the main one', () => {
    const main = new FakeWindow({})
    main.bounds = { x: 200, y: 100, width: 1200, height: 800 }
    setMainWindow(main as never)
    rmSync(join(state.home, 'detached-terminal.json'), { force: true })
    detachedTerminals.detach('t1')
    expect(state.windows.at(-1)!.options).toMatchObject({ x: 248, y: 148 })
    main.destroyed = true
    main.emit('closed')
    expect(mainWindow()).toBeNull()
  })
})

describe('styrWindowOptions', () => {
  it('is sandboxed and hidden until painted', () => {
    const options = styrWindowOptions({ width: 800, height: 600 })
    expect(options).toMatchObject({ width: 800, height: 600, show: false })
    expect(options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true })
  })
})
