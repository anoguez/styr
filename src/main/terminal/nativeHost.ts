import { diagnosticDetail } from '@core/terminalEngine.js'
import type {
  EngineFrameLine,
  NativeAttachResult,
  NativeBlockEvent,
  NativeEngineFailure,
  NativeEngineStatus,
  NativeFrameEvent,
  TerminalMark,
  TerminalOutput
} from '@core/types.js'
import type { NativeEngineFactory, NativeTerminalEngine } from './nativeEngine.js'
import { BlockSession, STYLED_BATCH, supportsBlockList } from './blockSession.js'
import { CommandBlockTracker } from './commandBlockTracker.js'

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
/** Most lines one `styledLines` call reads: the whole scrollback and the largest screen. */
const MAX_READ_LINES = NATIVE_SCROLLBACK + 500

export interface NativeHostPorts {
  factory: () => NativeEngineFactory | undefined
  status: () => NativeEngineStatus
  backlog: (id: string) => TerminalOutput
  /** Bytes for the PTY: the engine's answers to device queries (cursor position and the like). */
  writeToPty: (id: string, data: string) => void
  sendFrame: (event: NativeFrameEvent) => void
  /** Changes to a session's block list (see `BlockSession`), in order. */
  sendBlocks: (event: NativeBlockEvent) => void
  sendFailure: (failure: NativeEngineFailure) => void
  /** Runs `task` once the current burst of PTY events has been handled (`setImmediate`). */
  defer: (task: () => void) => void
  /**
   * `STYR_TERMINAL_BENCH` only: the marks whose output has just been sent to the renderer, so a
   * command's end can be timed when it was drawn. Unset, the host keeps no marks for it.
   */
  drawn?: (id: string, marks: TerminalMark[]) => void
}

interface Attached {
  attachId: number
  engine: NativeTerminalEngine
  flushQueued: boolean
  /** Tracks command marks when the engine supports them. */
  commandBlocks?: CommandBlockTracker
  /** The blocks last sent, to send them again only when they change. */
  sentBlocks: string
  /** The engine can draw the Warp-style block list (package 0.3.0). */
  canList: boolean
  /** The block list, from the shell's first prompt mark on. */
  blockList?: BlockSession
  size: { cols: number; rows: number }
  create: NativeEngineFactory['create']
  /** Marks written since the last flush, kept only for `drawn`. */
  drawnMarks: TerminalMark[]
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
    let entry: Attached | undefined
    try {
      engine = factory.create({ cols, rows, scrollback: NATIVE_SCROLLBACK })
      entry = {
        attachId: this.nextAttachId++,
        engine,
        flushQueued: false,
        commandBlocks: CommandBlockTracker.create(engine),
        sentBlocks: '',
        drawnMarks: [],
        canList: supportsBlockList(engine),
        size: { cols, rows },
        create: (options) => factory.create(options)
      }
      // The backlog carries its marks, so a remount rebuilds the same blocks.
      writeMarked(entry, this.ports.backlog(id))
      // Replies to queries in old output were answered by whoever showed it first.
      engine.takeResponses()
      const frame = engine.snapshot()
      // Everything so far is in the snapshot; the next frame should carry only what changes.
      engine.takeFrame()
      const blocks = entry.commandBlocks?.snapshot() ?? []
      entry.sentBlocks = JSON.stringify(blocks)
      entry.blockList?.takeResponses()
      const blockList = entry.blockList?.snapshot()
      this.attached.set(id, entry)
      return {
        ok: true,
        attachId: entry.attachId,
        frame,
        blocks,
        ...(blockList ? { blockList } : {}),
        info: factory.info
      }
    } catch (error) {
      entry?.blockList?.dispose()
      safeDispose(engine)
      return { ok: false, reason: 'init-failed', detail: diagnosticDetail(error) }
    }
  }

  /** PTY output for any session; ignored unless the session has an engine. */
  write(id: string, output: TerminalOutput): void {
    const entry = this.attached.get(id)
    if (!entry || (!output.data && output.marks.length === 0)) return
    this.guard(id, () => writeMarked(entry, output))
    if (this.ports.drawn) entry.drawnMarks.push(...output.marks)
    this.scheduleFlush(id)
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.attached.get(id)
    if (!entry) return
    this.guard(id, () => {
      entry.engine.resize(cols, rows)
      entry.size = { cols, rows }
      entry.blockList?.resize(cols, rows)
    })
    this.scheduleFlush(id)
  }

  /** Empties the session's block list (Ctrl+L in the block terminal). */
  clearBlocks(id: string): void {
    const entry = this.attached.get(id)
    if (!entry?.blockList) return
    this.guard(id, () => entry.blockList!.clear())
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

  /**
   * Absolute lines [from, to) of the grid as styled rows, for copying a selection that reaches
   * past the screen. An engine before 0.3.0 has no styled lines, so its rows are plain text.
   */
  styledLines(id: string, from: number, to: number): EngineFrameLine[] {
    const entry = this.attached.get(id)
    if (!entry) return []
    const start = Math.max(0, Math.floor(from))
    const end = Math.min(Math.floor(to), start + MAX_READ_LINES)
    return (
      this.guard(id, () => {
        const { engine } = entry
        const rows: EngineFrameLine[] = []
        for (let batch = start; batch < end; batch += STYLED_BATCH) {
          const last = Math.min(end, batch + STYLED_BATCH)
          if (engine.styledLines) rows.push(...engine.styledLines(batch, last))
          else for (let line = batch; line < last; line++) rows.push(plainRow(engine, line))
        }
        return rows
      }) ?? []
    )
  }

  /** Frees the engine; the panel closed, the session exited or the renderer fell back. */
  detach(id: string): void {
    const entry = this.attached.get(id)
    if (!entry) return
    this.attached.delete(id)
    entry.blockList?.dispose()
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
      const list = entry.blockList
      if (list) {
        // The live segment's engine is the one the program is talking to; it answers queries.
        entry.engine.takeResponses()
        const responses = list.takeResponses()
        if (responses) this.ports.writeToPty(id, responses)
        // The whole-session engine keeps parsing (copy all, a fallback to the grid) but its
        // frames are not drawn while the block list is.
        entry.engine.takeFrame()
        const events = list.takeEvents()
        if (events.length > 0) {
          this.ports.sendBlocks({ id, attachId: entry.attachId, events })
        }
        return
      }
      const responses = entry.engine.takeResponses()
      if (responses) this.ports.writeToPty(id, responses)
      const frame = entry.engine.takeFrame() ?? undefined
      const blocks = entry.commandBlocks?.snapshot() ?? []
      const key = JSON.stringify(blocks)
      const changed = key !== entry.sentBlocks
      entry.sentBlocks = key
      if (frame || changed) {
        this.ports.sendFrame({
          id,
          attachId: entry.attachId,
          ...(frame ? { frame } : {}),
          ...(changed ? { blocks } : {})
        })
      }
    })
    if (entry.drawnMarks.length > 0 && this.attached.get(id) === entry) {
      const marks = entry.drawnMarks.splice(0)
      this.ports.drawn?.(id, marks)
    }
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

/**
 * Writes output and places its command marks between the right two pieces of it, so the engine's
 * cursor is exactly where the shell's was when it reported the boundary (as `writeOutput` does for
 * xterm.js in the renderer).
 */
function writeMarked(entry: Attached, output: Pick<TerminalOutput, 'data' | 'marks'>): void {
  const write = (data: string): void => {
    writeChunked(entry.engine, data)
    if (entry.blockList) writeChunked(entry.blockList, data)
  }
  if (output.marks.length === 0) {
    write(output.data)
    return
  }
  let written = 0
  for (const mark of [...output.marks].sort((left, right) => left.offset - right.offset)) {
    const offset = Math.min(Math.max(mark.offset, written), output.data.length)
    write(output.data.slice(written, offset))
    entry.commandBlocks?.observe(mark)
    if (entry.blockList) entry.blockList.mark(mark)
    else if (entry.canList && mark.kind === 'prompt') {
      entry.blockList = new BlockSession(entry.create, entry.size, mark)
    }
    written = offset
  }
  write(output.data.slice(written))
}

function writeChunked(engine: Pick<NativeTerminalEngine, 'write'>, data: string): void {
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

function plainRow(engine: NativeTerminalEngine, line: number): EngineFrameLine {
  const text = engine.lines(line, line + 1)
  return {
    row: line,
    wrapped: false,
    runs: text ? [{ text, width: [...text].length, fg: -1, bg: -1, flags: 0 }] : []
  }
}

function safeDispose(engine: NativeTerminalEngine | undefined): void {
  try {
    engine?.dispose()
  } catch {
    // A poisoned engine may throw on dispose too; it is being dropped either way.
  }
}
