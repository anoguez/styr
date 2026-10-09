import { diagnosticDetail } from '@core/terminalEngine.js'
import type {
  NativeAttachResult,
  NativeEngineFailure,
  NativeEngineStatus,
  NativeFrameEvent,
  TerminalOutput
} from '@core/types.js'
import type { NativeEngineFactory, NativeTerminalEngine } from './nativeEngine.js'

/**
 * Runs Styr Terminal engines for the sessions the renderer shows with the native engine. The PTY is
 * untouched: `ptyManager` still owns it and keeps its backlog, and this host only reads the same
 * output xterm.js would have. That is what makes fallback lossless — when an engine fails, the
 * renderer mounts xterm.js, which replays the backlog and continues from the live stream by
 * sequence number exactly as on any first mount (`TerminalOutputSynchronizer`).
 */

/** Lines of history each engine keeps; xterm.js keeps its default 1 000, so this is generous. */
export const NATIVE_SCROLLBACK = 10_000
/**
 * Output is written in pieces of at most this many UTF-16 units. At four UTF-8 bytes per unit at
 * worst, a piece stays under the engine's 1 MiB per-call limit.
 */
export const WRITE_CHUNK = 128 * 1024

export interface NativeHostPorts {
  factory: () => NativeEngineFactory | undefined
  status: () => NativeEngineStatus
  backlog: (id: string) => TerminalOutput
  /** Bytes for the PTY: the engine's answers to device queries (cursor position and the like). */
  writeToPty: (id: string, data: string) => void
  sendFrame: (event: NativeFrameEvent) => void
  sendFailure: (failure: NativeEngineFailure) => void
  /** Runs `task` once the current burst of PTY events has been handled (`setImmediate`). */
  defer: (task: () => void) => void
}

interface Attached {
  attachId: number
  engine: NativeTerminalEngine
  flushQueued: boolean
}

export class NativeTerminalHost {
  private readonly attached = new Map<string, Attached>()
  private nextAttachId = 1

  constructor(private readonly ports: NativeHostPorts) {}

  has(id: string): boolean {
    return this.attached.has(id)
  }

  get size(): number {
    return this.attached.size
  }

  /**
   * Starts (or restarts) an engine for `id`, seeded with the session's backlog, and returns its
   * first full frame. Synchronous on purpose: the backlog is read and the engine registered in one
   * turn of the main process, so live output after it can be neither missed nor written twice.
   */
  attach(id: string, cols: number, rows: number): NativeAttachResult {
    this.detach(id)
    const status = this.ports.status()
    const factory = this.ports.factory()
    if (!status.available || !factory) {
      return status.available
        ? { ok: false, reason: 'missing-package', detail: 'Engine not loaded' }
        : { ok: false, reason: status.reason, detail: status.detail }
    }
    let engine: NativeTerminalEngine | undefined
    try {
      engine = factory.create({ cols, rows, scrollback: NATIVE_SCROLLBACK })
      writeChunked(engine, this.ports.backlog(id).data)
      // Replies to queries in old output were answered by whoever showed it first.
      engine.takeResponses()
      const frame = engine.snapshot()
      // Everything so far is in the snapshot; the next frame should carry only what changes.
      engine.takeFrame()
      const attachId = this.nextAttachId++
      this.attached.set(id, { attachId, engine, flushQueued: false })
      return { ok: true, attachId, frame, info: factory.info }
    } catch (error) {
      safeDispose(engine)
      return { ok: false, reason: 'init-failed', detail: diagnosticDetail(error) }
    }
  }

  /** PTY output for any session; ignored unless the session has an engine. */
  write(id: string, output: TerminalOutput): void {
    const entry = this.attached.get(id)
    if (!entry || !output.data) return
    this.guard(id, () => writeChunked(entry.engine, output.data))
    this.scheduleFlush(id)
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.attached.get(id)
    if (!entry) return
    this.guard(id, () => entry.engine.resize(cols, rows))
    this.scheduleFlush(id)
  }

  /** Positive scrolls up into history; `bottom` returns to the live screen. */
  scroll(id: string, lines: number | 'bottom'): void {
    const entry = this.attached.get(id)
    if (!entry) return
    this.guard(id, () =>
      lines === 'bottom' ? entry.engine.scrollToBottom() : entry.engine.scroll(lines)
    )
    this.scheduleFlush(id)
  }

  text(id: string): string {
    const entry = this.attached.get(id)
    return (entry && this.guard(id, () => entry.engine.text())) ?? ''
  }

  lines(id: string, from: number, to: number): string {
    const entry = this.attached.get(id)
    return (entry && this.guard(id, () => entry.engine.lines(from, to))) ?? ''
  }

  /** Frees the engine; the panel closed, the session exited or the renderer fell back. */
  detach(id: string): void {
    const entry = this.attached.get(id)
    if (!entry) return
    this.attached.delete(id)
    safeDispose(entry.engine)
  }

  detachAll(): void {
    for (const id of [...this.attached.keys()]) this.detach(id)
  }

  private scheduleFlush(id: string): void {
    const entry = this.attached.get(id)
    if (!entry || entry.flushQueued) return
    entry.flushQueued = true
    this.ports.defer(() => this.flush(id, entry))
  }

  /** At most one frame per session per burst, however many PTY chunks arrived. */
  private flush(id: string, entry: Attached): void {
    entry.flushQueued = false
    if (this.attached.get(id) !== entry) return
    this.guard(id, () => {
      const responses = entry.engine.takeResponses()
      if (responses) this.ports.writeToPty(id, responses)
      const frame = entry.engine.takeFrame()
      if (frame) this.ports.sendFrame({ id, attachId: entry.attachId, frame })
    })
  }

  /**
   * Runs one engine call. A throw means the engine can no longer be trusted for this session: it is
   * freed and the renderer told to fall back. The PTY and its backlog are not touched.
   */
  private guard<T>(id: string, call: () => T): T | undefined {
    try {
      return call()
    } catch (error) {
      this.detach(id)
      this.ports.sendFailure({ id, reason: 'runtime-error', detail: diagnosticDetail(error) })
      return undefined
    }
  }
}

function writeChunked(engine: NativeTerminalEngine, data: string): void {
  let start = 0
  while (start < data.length) {
    let end = Math.min(start + WRITE_CHUNK, data.length)
    // Never split a surrogate pair: half of one is not valid UTF-16, let alone UTF-8.
    const last = data.charCodeAt(end - 1)
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    engine.write(data.slice(start, end))
    start = end
  }
}

function safeDispose(engine: NativeTerminalEngine | undefined): void {
  try {
    engine?.dispose()
  } catch {
    // A poisoned engine may throw on dispose too; it is being dropped either way.
  }
}
