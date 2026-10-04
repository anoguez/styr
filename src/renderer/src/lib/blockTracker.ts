import type { IDisposable, IMarker, Terminal } from '@xterm/xterm'
import type { TerminalMark } from '@core/types.js'

/** A command as the surface sees it: where it sits in the buffer and how it went. */
export interface TrackedBlock {
  id: string
  command: string
  startedAt: number
  endedAt?: number
  exitCode?: number
  /** Buffer line of the command's own row (the prompt it was typed on). */
  startLine: number
  /** Buffer line after the last output row, so output is `startLine + 1 … endLine - 1`. */
  endLine: number
  /** Still running: `endLine` follows the cursor. */
  open: boolean
}

export interface BlockLayout {
  blocks: TrackedBlock[]
  /** Buffer line shown at the top of the viewport. */
  viewportY: number
  rows: number
  cellHeight: number
  /** Pixels from the top of the terminal's box to the first row. */
  top: number
  /** The alternate screen is showing, where blocks have no meaning. */
  alternate: boolean
}

interface Tracked {
  id: string
  command: string
  startedAt: number
  endedAt?: number
  exitCode?: number
  start: IMarker
  end?: IMarker
  /** The last output row had no newline, so the end marker's own row belongs to the block. */
  endPartial: boolean
}

/**
 * Follows commands through an xterm buffer using its own markers, so the lines stay right as
 * output scrolls, wraps on resize and is trimmed from the scrollback. It never reads or rewrites
 * output: it only remembers *where* the shell said a command began and ended, and reports
 * geometry for the surface to draw over. Disposed markers drop their block.
 */
export class BlockTracker {
  private readonly blocks = new Map<string, Tracked>()
  private readonly subscriptions: IDisposable[] = []
  private frame = 0

  constructor(
    private readonly terminal: Terminal,
    private readonly host: HTMLElement,
    private readonly onLayout: (layout: BlockLayout) => void
  ) {
    this.subscriptions.push(
      terminal.onScroll(() => this.schedule()),
      terminal.onWriteParsed(() => this.schedule()),
      terminal.onResize(() => this.schedule()),
      terminal.buffer.onBufferChange(() => this.schedule())
    )
  }

  /** Call once everything before `mark` has been parsed, so the cursor is where the shell was. */
  mark(mark: TerminalMark): void {
    if (this.terminal.buffer.active.type === 'alternate') return
    if (mark.kind === 'start') {
      // The shell announces a command after Enter has moved the cursor down, so its own row is the
      // one above.
      const start = this.terminal.registerMarker(-1)
      if (!start) return
      const block: Tracked = {
        id: mark.id,
        command: mark.command ?? '',
        startedAt: mark.at,
        start,
        endPartial: false
      }
      this.blocks.set(mark.id, block)
      start.onDispose(() => this.blocks.delete(mark.id))
    } else {
      const block = this.blocks.get(mark.id)
      if (!block || block.end) return
      const end = this.terminal.registerMarker(0)
      if (!end) return
      block.end = end
      block.endPartial = this.terminal.buffer.active.cursorX > 0
      block.endedAt = mark.at
      block.exitCode = mark.exitCode
    }
    this.schedule()
  }

  layout(): BlockLayout {
    const buffer = this.terminal.buffer.active
    const screen = this.host.querySelector<HTMLElement>('.xterm-screen')
    const rows = this.terminal.rows
    const cellHeight = screen && rows > 0 ? screen.clientHeight / rows : 0
    const top = screen
      ? screen.getBoundingClientRect().top - this.host.getBoundingClientRect().top
      : 0
    const cursorLine = buffer.baseY + buffer.cursorY
    const blocks: TrackedBlock[] = []
    for (const block of this.blocks.values()) {
      if (block.start.line < 0) continue
      const open = !block.end
      const endLine = block.end
        ? block.end.line + (block.endPartial ? 1 : 0)
        : cursorLine + (buffer.cursorX > 0 ? 1 : 0)
      blocks.push({
        id: block.id,
        command: block.command,
        startedAt: block.startedAt,
        endedAt: block.endedAt,
        exitCode: block.exitCode,
        startLine: block.start.line,
        endLine: Math.max(endLine, block.start.line + 1),
        open
      })
    }
    blocks.sort((left, right) => left.startLine - right.startLine)
    return {
      blocks,
      viewportY: buffer.viewportY,
      rows,
      cellHeight,
      top,
      alternate: buffer.type === 'alternate'
    }
  }

  /** The buffer line under a client Y coordinate, or null outside the screen. */
  lineAt(clientY: number): number | null {
    const screen = this.host.querySelector<HTMLElement>('.xterm-screen')
    if (!screen || this.terminal.rows === 0) return null
    const box = screen.getBoundingClientRect()
    const cell = box.height / this.terminal.rows
    if (cell <= 0 || clientY < box.top || clientY >= box.bottom) return null
    return this.terminal.buffer.active.viewportY + Math.floor((clientY - box.top) / cell)
  }

  /** Coalesces bursts of output into one layout report per frame. */
  schedule(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.onLayout(this.layout())
    })
  }

  dispose(): void {
    if (this.frame) cancelAnimationFrame(this.frame)
    for (const subscription of this.subscriptions) subscription.dispose()
    for (const block of this.blocks.values()) {
      block.start.dispose()
      block.end?.dispose()
    }
    this.blocks.clear()
  }
}
