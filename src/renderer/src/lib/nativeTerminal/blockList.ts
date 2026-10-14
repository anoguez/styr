import type {
  ActiveSegment,
  BlockListEvent,
  BlockListSnapshot,
  EngineFrameLine,
  EngineRun,
  FinishedCommandBlock,
  NativeBlockEvent
} from '@core/types.js'
import { ScreenModel } from './screen.js'

/**
 * Finished blocks the view keeps, the rows across them (the main process's `MAX_FINISHED_ROWS`),
 * and history rows of a running command; oldest go first.
 */
export const VIEW_FINISHED_BLOCKS = 300
export const VIEW_FINISHED_ROWS = 50_000
export const VIEW_HISTORY_ROWS = 10_000
/** Rows a history chunk takes before it is closed (more if its last line is still wrapping). */
export const HISTORY_CHUNK_ROWS = 256

/**
 * A run of a running command's history rows. A chunk is closed once it holds `HISTORY_CHUNK_ROWS`
 * and ends a logical line, and never changes after that, so the view draws it once (`id` keys it)
 * and only redraws the open last chunk as output streams in.
 */
export interface HistoryChunk {
  id: number
  rows: EngineFrameLine[]
}

export interface BlockListState {
  finished: FinishedCommandBlock[]
  active: ActiveSegment
  /** Rows of the running command that have scrolled off its screen, oldest chunk first. */
  history: HistoryChunk[]
  /** The live segment's screen: the prompt being drawn, or the running command's. */
  screen: ScreenModel
}

/**
 * The renderer's copy of a session's block list (see `BlockSession` in the main process). It is
 * null while the session is a plain grid, and starts with the attach snapshot or with the first
 * `segment` event. Events that overtake the attach reply are held and replayed after it, and events
 * from an engine since replaced are dropped, as `BlockFeed` does for overlay blocks.
 */
export class BlockListStore {
  state: BlockListState | null = null
  private attachId: number | null = null
  private held: NativeBlockEvent[] = []
  private nextChunk = 1

  attached(attachId: number, snapshot: BlockListSnapshot | undefined): void {
    this.attachId = attachId
    if (snapshot) {
      const screen = new ScreenModel()
      screen.reset(snapshot.frame)
      this.state = {
        finished: capFinished(snapshot.finished),
        active: snapshot.active,
        history: this.appendHistory([], snapshot.history),
        screen
      }
    }
    const held = this.held
    this.held = []
    for (const event of held) this.received(event)
  }

  /** Returns whether anything shown changed. */
  received(event: NativeBlockEvent): boolean {
    if (this.attachId === null) {
      this.held.push(event)
      return false
    }
    if (event.attachId !== this.attachId) return false
    let changed = false
    for (const item of event.events) changed = this.apply(item) || changed
    return changed
  }

  private apply(event: BlockListEvent): boolean {
    if (event.kind === 'segment') {
      const screen = new ScreenModel()
      screen.reset(event.frame)
      this.state = {
        finished: this.state?.finished ?? [],
        active: event.segment,
        history: [],
        screen
      }
      return true
    }
    const state = this.state
    if (!state) return false
    if (event.kind === 'finished') {
      state.finished = capFinished([...state.finished, event.block])
      return true
    }
    if (event.kind === 'cleared') {
      state.finished = []
      return true
    }
    if (event.kind === 'history') {
      state.history = this.appendHistory(state.history, event.rows)
      return true
    }
    return state.screen.push(event.frame)
  }

  /**
   * Adds rows to the open last chunk, closing it as it fills, and drops whole chunks from the front
   * past `VIEW_HISTORY_ROWS`. Closed chunks keep their identity, so the view redraws only the last.
   */
  private appendHistory(chunks: HistoryChunk[], rows: EngineFrameLine[]): HistoryChunk[] {
    if (rows.length === 0) return chunks
    const next = [...chunks]
    const last = next.at(-1)
    let open: HistoryChunk | null = null
    if (last && !closed(last.rows)) {
      open = { id: last.id, rows: [...last.rows] }
      next[next.length - 1] = open
    }
    for (const row of rows) {
      if (!open) {
        open = { id: this.nextChunk++, rows: [] }
        next.push(open)
      }
      open.rows.push(row)
      if (closed(open.rows)) open = null
    }
    let total = next.reduce((sum, chunk) => sum + chunk.rows.length, 0)
    while (next.length > 1 && total - next[0]!.rows.length >= VIEW_HISTORY_ROWS) {
      total -= next.shift()!.rows.length
    }
    return next
  }
}

/** The newest finished blocks within both caps; the newest one is kept whatever its size. */
function capFinished(blocks: FinishedCommandBlock[]): FinishedCommandBlock[] {
  let start = Math.max(0, blocks.length - VIEW_FINISHED_BLOCKS)
  let rows = 0
  for (let index = blocks.length - 1; index >= start; index--) {
    rows += blocks[index]!.output.length
    if (rows > VIEW_FINISHED_ROWS && index < blocks.length - 1) {
      start = index + 1
      break
    }
  }
  return start === 0 ? blocks : blocks.slice(start)
}

/**
 * A chunk closes at a line's end so no logical line spans two; a line that wraps on and on (one
 * huge line of output) is cut anyway at four chunks' worth, which keeps the row cap a cap.
 */
function closed(rows: EngineFrameLine[]): boolean {
  if (rows.length >= HISTORY_CHUNK_ROWS * 4) return true
  return rows.length >= HISTORY_CHUNK_ROWS && !rows.at(-1)!.wrapped
}

/**
 * Rejoins rows into logical lines, so the page can wrap them at whatever width it has. A wrapped
 * row is padded to the width it was drawn at first: the engine drops trailing blanks, and a space
 * that fell at the wrap point is still part of the line.
 */
export function logicalLines(rows: EngineFrameLine[], cols: number): EngineRun[][] {
  const lines: EngineRun[][] = []
  let current: EngineRun[] | null = null
  for (const row of rows) {
    const runs: EngineRun[] = current ?? []
    runs.push(...row.runs)
    if (row.wrapped) {
      const width = row.runs.reduce((sum, run) => sum + run.width, 0)
      if (width < cols) {
        const pad = cols - width
        runs.push({ text: ' '.repeat(pad), width: pad, fg: -1, bg: -1, flags: 0 })
      }
      current = runs
    } else {
      lines.push(runs)
      current = null
    }
  }
  if (current) lines.push(current)
  return lines
}

/** The live screen's rows down to the cursor or the last row with anything on it. */
export function liveRows(screen: ScreenModel): EngineFrameLine[] {
  const state = screen.current
  if (!state) return []
  let last = state.cursor.row
  for (let row = state.lines.length - 1; row > last; row--) {
    const line = state.lines[row]!
    if (line.runs.length > 0 || line.wrapped) {
      last = row
      break
    }
  }
  return state.lines.slice(0, last + 1)
}

/** A row list as plain text, wrapped rows rejoined. */
export function rowsText(rows: EngineFrameLine[], cols: number): string {
  return logicalLines(rows, cols)
    .map((runs) =>
      runs
        .map((run) => run.text)
        .join('')
        .trimEnd()
    )
    .join('\n')
    .trimEnd()
}

/**
 * The commands to step through with Up and Down in the input, oldest first: the list's commands
 * and the running one, without blanks or repeats of the one before.
 */
export function commandHistory(state: BlockListState): string[] {
  const commands = state.finished.map((block) => block.command)
  if (state.active.kind === 'running') commands.push(state.active.command)
  const history: string[] = []
  for (const command of commands) {
    if (command.trim() && history.at(-1) !== command) history.push(command)
  }
  return history
}
