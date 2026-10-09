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

/** Finished blocks the view keeps, and history rows of a running command; oldest go first. */
export const VIEW_FINISHED_BLOCKS = 300
export const VIEW_HISTORY_ROWS = 10_000

export interface BlockListState {
  finished: FinishedCommandBlock[]
  active: ActiveSegment
  /** Rows of the running command that have scrolled off its screen. */
  history: EngineFrameLine[]
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

  attached(attachId: number, snapshot: BlockListSnapshot | undefined): void {
    this.attachId = attachId
    if (snapshot) {
      const screen = new ScreenModel()
      screen.reset(snapshot.frame)
      this.state = {
        finished: snapshot.finished.slice(-VIEW_FINISHED_BLOCKS),
        active: snapshot.active,
        history: snapshot.history.slice(-VIEW_HISTORY_ROWS),
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
      state.finished = [...state.finished, event.block].slice(-VIEW_FINISHED_BLOCKS)
      return true
    }
    if (event.kind === 'cleared') {
      state.finished = []
      return true
    }
    if (event.kind === 'history') {
      state.history = [...state.history, ...event.rows].slice(-VIEW_HISTORY_ROWS)
      return true
    }
    return state.screen.push(event.frame)
  }
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
