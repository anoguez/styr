import type {
  ActiveSegment,
  BlockListEvent,
  BlockListSnapshot,
  EngineFrameLine,
  FinishedCommandBlock,
  TerminalMark
} from '@core/types.js'
import type { NativeTerminalEngine } from './nativeEngine.js'

/**
 * The Warp-style view of one native session: the shell's output split at its own marks into a list
 * of finished commands, plus one live segment — the prompt waiting for input, or the command that
 * is running. Each segment gets a fresh engine, so a command's output is its own grid: a program
 * that clears or redraws only touches its own block, and a finished block is frozen into rows the
 * renderer re-wraps at any width. The PTY, its backlog and the session's main engine are untouched;
 * this only reads the same output. The host starts one at a session's first prompt mark, which only
 * a shell with Styr's integration sends — any other shell stays a plain grid.
 *
 * The shell's own prompt is parsed in its segment — it can switch modes (bracketed paste) or ask
 * where the cursor is — but never shown: the block list draws Styr's prompt instead.
 */

/** Lines a command's own engine keeps; a longer output loses its oldest lines (`truncated`). */
export const BLOCK_SCROLLBACK = 10_000
/** Lines the prompt's engine keeps: a prompt is a few lines. */
const PROMPT_SCROLLBACK = 200
/** Finished blocks kept, and rows across them; the oldest go first. */
export const MAX_FINISHED_BLOCKS = 200
export const MAX_FINISHED_ROWS = 50_000
/** `styledLines` returns at most this many lines per call (protocol). */
const STYLED_BATCH = 5000
/** The mark on the last history row already sent for the running command. */
const SENT_MARK = 'styr-sent'
const CLEAR_COMMAND = /^\s*(clear|reset|tput\s+(clear|reset))\s*$/

/** The protocol methods (package 0.3.0) a block list needs on top of a plain engine. */
type BlockEngine = NativeTerminalEngine &
  Required<
    Pick<
      NativeTerminalEngine,
      'markLine' | 'markedLines' | 'cursorPosition' | 'styledLines' | 'totalLines'
    >
  >

export function supportsBlockList(engine: NativeTerminalEngine): boolean {
  return (
    typeof engine.styledLines === 'function' &&
    typeof engine.totalLines === 'function' &&
    typeof engine.markLine === 'function' &&
    typeof engine.markedLines === 'function' &&
    typeof engine.cursorPosition === 'function'
  )
}

type Size = { cols: number; rows: number }
type CreateEngine = (options: Size & { scrollback: number }) => NativeTerminalEngine

interface Segment {
  engine: BlockEngine
  kind: 'prompt' | 'running'
  id: string
  cwd?: string
  /** A prompt segment opened when a command ended, before the shell said it is drawing one. */
  awaitingPrompt?: boolean
  command?: string
  startedAt: number
}

export class BlockSession {
  private finished: FinishedCommandBlock[] = []
  private finishedRows = 0
  private segment: Segment
  private events: BlockListEvent[] = []

  /**
   * Starts at the session's first prompt mark: only a shell with Styr's integration sends one, and
   * what it printed before (a login banner) is not a command, so the list starts empty.
   */
  constructor(
    private readonly create: CreateEngine,
    private size: Size,
    first: TerminalMark
  ) {
    this.segment = this.promptSegment(first)
    // A view showing the grid until now learns the list has started from this first segment.
    this.announce()
  }

  /** Output between two marks, for the live segment. */
  write(data: string): void {
    if (data) this.segment.engine.write(data)
  }

  mark(mark: TerminalMark): void {
    if (mark.kind === 'prompt') this.prompt(mark)
    else if (mark.kind === 'start') this.start(mark)
    else this.end(mark)
  }

  resize(cols: number, rows: number): void {
    this.size = { cols, rows }
    this.segment.engine.resize(cols, rows)
  }

  /** Clears the list, as `clear` or Ctrl+L does in a block terminal; the live segment stays. */
  clear(): void {
    this.dropFinished()
    this.events.push({ kind: 'cleared' })
  }

  /** Replies the live segment's program expects on the PTY (cursor position and the like). */
  takeResponses(): string {
    return this.segment.engine.takeResponses()
  }

  /** What changed since the last call: list changes in order, then the live segment's news. */
  takeEvents(): BlockListEvent[] {
    if (this.segment.kind === 'running') {
      const rows = this.newHistory()
      if (rows.length > 0) this.events.push({ kind: 'history', rows })
    }
    const frame = this.segment.engine.takeFrame()
    if (frame) this.events.push({ kind: 'frame', frame })
    const events = this.events
    this.events = []
    return events
  }

  /** The whole list, for a view attaching now. Resets what `takeEvents` reports next. */
  snapshot(): BlockListSnapshot {
    this.events = []
    const history = this.segment.kind === 'running' ? this.allHistory() : []
    const frame = this.segment.engine.snapshot()
    this.segment.engine.takeFrame()
    return { finished: [...this.finished], active: this.activeSegment(), history, frame }
  }

  dispose(): void {
    safeDispose(this.segment.engine)
  }

  private engine(scrollback = PROMPT_SCROLLBACK): BlockEngine {
    return this.create({ ...this.size, scrollback }) as BlockEngine
  }

  private prompt(mark: TerminalMark): void {
    const current = this.segment
    if (current.kind === 'prompt' && current.awaitingPrompt) {
      // The prompt segment opened when the command ended; the shell is now drawing into it.
      current.awaitingPrompt = false
      current.id = mark.id
      current.cwd = mark.cwd
      return
    }
    if (current.kind === 'running') {
      // The command ended without its end mark (its shell was replaced, say): keep what it showed.
      this.finish(current, mark.at, undefined)
    }
    // A prompt that is replaced without running anything (an empty line) is dropped.
    this.open(this.promptSegment(mark))
  }

  private promptSegment(mark: TerminalMark): Segment {
    return {
      kind: 'prompt',
      id: mark.id,
      ...(mark.cwd ? { cwd: mark.cwd } : {}),
      startedAt: mark.at,
      engine: this.engine()
    }
  }

  private start(mark: TerminalMark): void {
    const current = this.segment
    if (current.kind === 'running') this.finish(current, mark.at, undefined)
    this.open({
      kind: 'running',
      id: mark.id,
      command: mark.command ?? '',
      cwd: current.cwd,
      startedAt: mark.at,
      engine: this.engine(BLOCK_SCROLLBACK)
    })
  }

  private end(mark: TerminalMark): void {
    const current = this.segment
    if (current.kind !== 'running' || current.id !== mark.id) return
    this.finish(current, mark.at, mark.exitCode)
    this.open({
      kind: 'prompt',
      id: `after-${mark.id}`,
      awaitingPrompt: true,
      startedAt: mark.at,
      engine: this.engine()
    })
  }

  private finish(segment: Segment, endedAt: number, exitCode: number | undefined): void {
    if (CLEAR_COMMAND.test(segment.command ?? '')) {
      this.clear()
      return
    }
    const total = segment.engine.totalLines()
    this.addFinished({
      id: segment.id,
      command: segment.command ?? '',
      ...(segment.cwd ? { cwd: segment.cwd } : {}),
      startedAt: segment.startedAt,
      endedAt,
      ...(exitCode !== undefined ? { exitCode } : {}),
      cols: this.size.cols,
      output: rowsOf(segment.engine),
      // The engine keeps BLOCK_SCROLLBACK lines of history; a full history has lost older ones.
      truncated: total - this.size.rows >= BLOCK_SCROLLBACK
    })
  }

  private open(segment: Segment): void {
    safeDispose(this.segment.engine)
    this.segment = segment
    this.announce()
  }

  private announce(): void {
    const frame = this.segment.engine.snapshot()
    this.segment.engine.takeFrame()
    this.events.push({ kind: 'segment', segment: this.activeSegment(), frame })
  }

  private activeSegment(): ActiveSegment {
    const { kind, id, cwd, command, startedAt } = this.segment
    if (kind === 'running') {
      return {
        kind,
        id,
        command: command ?? '',
        startedAt,
        ...(cwd ? { cwd } : {})
      }
    }
    return { kind: 'prompt', id, ...(cwd ? { cwd } : {}) }
  }

  private addFinished(block: FinishedCommandBlock): void {
    this.finished.push(block)
    this.finishedRows += block.output.length
    while (
      this.finished.length > MAX_FINISHED_BLOCKS ||
      (this.finishedRows > MAX_FINISHED_ROWS && this.finished.length > 1)
    ) {
      this.finishedRows -= this.finished.shift()!.output.length
    }
    this.events.push({ kind: 'finished', block })
  }

  private dropFinished(): void {
    this.finished = []
    this.finishedRows = 0
  }

  /** Lines above the running command's screen, which no longer change. */
  private historySize(): number {
    return Math.max(0, this.segment.engine.totalLines() - this.size.rows)
  }

  /**
   * History rows not yet sent. The last sent row carries a mark, so this stays right when the
   * engine trims its oldest lines: everything after the mark is new, and if the mark itself was
   * trimmed, everything left is.
   */
  private newHistory(): EngineFrameLine[] {
    const engine = this.segment.engine
    const end = this.historySize()
    const sent = engine.markedLines().find((line) => line.id === SENT_MARK)
    const start = sent ? sent.line + 1 : 0
    if (start >= end) return []
    const rows = readLines(engine, start, end)
    this.markSent(end)
    return rows
  }

  private allHistory(): EngineFrameLine[] {
    const end = this.historySize()
    if (end === 0) return []
    const rows = readLines(this.segment.engine, 0, end)
    this.markSent(end)
    return rows
  }

  private markSent(end: number): void {
    const engine = this.segment.engine
    engine.markLine(SENT_MARK, end - 1 - engine.cursorPosition().line)
  }
}

/** Every line of an engine with styles, trailing blank lines dropped. */
function rowsOf(engine: BlockEngine): EngineFrameLine[] {
  const rows = readLines(engine, 0, engine.totalLines())
  let end = rows.length
  while (end > 0 && rows[end - 1]!.runs.length === 0 && !rows[end - 1]!.wrapped) end -= 1
  return rows.slice(0, end)
}

function readLines(engine: BlockEngine, from: number, to: number): EngineFrameLine[] {
  const rows: EngineFrameLine[] = []
  for (let start = from; start < to; start += STYLED_BATCH) {
    rows.push(...engine.styledLines(start, Math.min(to, start + STYLED_BATCH)))
  }
  return rows
}

function safeDispose(engine: NativeTerminalEngine): void {
  try {
    engine.dispose()
  } catch {
    // Dropped either way.
  }
}
