import { diagnosticDetail } from '@core/terminalEngine.js'
import type {
  NativeAttachResult,
  NativeEngineFailure,
  NativeEngineStatus,
  NativeFrameEvent,
  TerminalMark,
  TerminalOutput,
  TrackedBlock
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

/** What the host knows of a command beyond where its mark is. */
interface Command {
  command: string
  startedAt: number
  endedAt?: number
  exitCode?: number
  /** Lines from the command's row to just past its output, fixed when it ends. */
  span?: number
}

interface Attached {
  attachId: number
  engine: NativeTerminalEngine
  flushQueued: boolean
  /** The engine can mark lines, so the session gets command blocks. */
  marks: boolean
  commands: Map<string, Command>
  /** The blocks last sent, to send them again only when they change. */
  sentBlocks: string
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
      const entry: Attached = {
        attachId: this.nextAttachId++,
        engine,
        flushQueued: false,
        marks: supportsMarks(engine),
        commands: new Map(),
        sentBlocks: ''
      }
      // The backlog carries its marks, so a remount rebuilds the same blocks.
      writeMarked(entry, this.ports.backlog(id))
      // Replies to queries in old output were answered by whoever showed it first.
      engine.takeResponses()
      const frame = engine.snapshot()
      // Everything so far is in the snapshot; the next frame should carry only what changes.
      engine.takeFrame()
      const blocks = blocksOf(entry)
      entry.sentBlocks = JSON.stringify(blocks)
      this.attached.set(id, entry)
      return { ok: true, attachId: entry.attachId, frame, blocks, info: factory.info }
    } catch (error) {
      safeDispose(engine)
      return { ok: false, reason: 'init-failed', detail: diagnosticDetail(error) }
    }
  }

  /** PTY output for any session; ignored unless the session has an engine. */
  write(id: string, output: TerminalOutput): void {
    const entry = this.attached.get(id)
    if (!entry || (!output.data && output.marks.length === 0)) return
    this.guard(id, () => writeMarked(entry, output))
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
      const frame = entry.engine.takeFrame() ?? undefined
      const blocks = blocksOf(entry)
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

function supportsMarks(engine: NativeTerminalEngine): boolean {
  return (
    typeof engine.markLine === 'function' &&
    typeof engine.markedLines === 'function' &&
    typeof engine.cursorPosition === 'function'
  )
}

/**
 * Writes output and places its command marks between the right two pieces of it, so the engine's
 * cursor is exactly where the shell's was when it reported the boundary (as `writeOutput` does for
 * xterm.js in the renderer).
 */
function writeMarked(entry: Attached, output: Pick<TerminalOutput, 'data' | 'marks'>): void {
  if (!entry.marks || output.marks.length === 0) {
    writeChunked(entry.engine, output.data)
    return
  }
  let written = 0
  for (const mark of [...output.marks].sort((left, right) => left.offset - right.offset)) {
    const offset = Math.min(Math.max(mark.offset, written), output.data.length)
    writeChunked(entry.engine, output.data.slice(written, offset))
    applyMark(entry, mark)
    written = offset
  }
  writeChunked(entry.engine, output.data.slice(written))
}

function applyMark(entry: Attached, mark: TerminalMark): void {
  const { engine, commands } = entry
  if (mark.kind === 'start') {
    // The shell announces a command after Enter has moved the cursor down, so its own row is the
    // one above. No mark (the alternate screen, say) means no block.
    if (engine.markLine!(mark.id, -1) === null) return
    commands.set(mark.id, { command: mark.command ?? '', startedAt: mark.at })
    return
  }
  const command = commands.get(mark.id)
  if (!command || command.endedAt !== undefined) return
  const start = engine.markedLines!().find((line) => line.id === mark.id)
  if (!start) {
    commands.delete(mark.id)
    return
  }
  const cursor = engine.cursorPosition!()
  // Output without a final newline leaves the cursor on its last row, which then belongs to it.
  const end = cursor.line + (cursor.col > 0 ? 1 : 0)
  command.span = Math.max(1, end - start.line)
  command.endedAt = mark.at
  command.exitCode = mark.exitCode
}

/**
 * Where the session's commands are now. A command whose mark is gone (its row was trimmed from the
 * history, cleared or rewritten) is forgotten, which also keeps `commands` bounded by the buffer.
 */
function blocksOf(entry: Attached): TrackedBlock[] {
  if (!entry.marks || entry.commands.size === 0) return []
  const { engine, commands } = entry
  const marked = new Map(engine.markedLines!().map((line) => [line.id, line.line]))
  const cursor = engine.cursorPosition!()
  const blocks: TrackedBlock[] = []
  for (const [id, command] of commands) {
    const startLine = marked.get(id)
    if (startLine === undefined) {
      commands.delete(id)
      continue
    }
    const open = command.span === undefined
    const endLine = open ? cursor.line + (cursor.col > 0 ? 1 : 0) : startLine + (command.span ?? 1)
    blocks.push({
      id,
      command: command.command,
      startedAt: command.startedAt,
      ...(command.endedAt !== undefined ? { endedAt: command.endedAt } : {}),
      ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}),
      startLine,
      endLine: Math.max(endLine, startLine + 1),
      open
    })
  }
  return blocks.sort((left, right) => left.startLine - right.startLine)
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
