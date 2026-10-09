import type { EngineFrame, EngineFrameLine } from '@core/types.js'

/**
 * The renderer's copy of a native engine's viewport, rebuilt from frames. The first frame comes
 * from the attach call and later ones from `terminal:nativeFrame`; either may arrive first, so
 * frames received before the snapshot are held, and anything at or below the snapshot's `seq` is
 * already in it and dropped — the same rule `TerminalOutputSynchronizer` applies to PTY output.
 */
export class ScreenModel {
  private frame: EngineFrame | null = null
  private rows: EngineFrameLine[] = []
  private pending: EngineFrame[] = []

  /** The latest frame's state with every row filled in, or null before the snapshot. */
  get current(): (Omit<EngineFrame, 'lines'> & { lines: EngineFrameLine[] }) | null {
    return this.frame ? { ...this.frame, lines: this.rows } : null
  }

  /** The attach snapshot: the baseline every later frame applies to. */
  reset(snapshot: EngineFrame): void {
    this.frame = null
    this.rows = []
    this.apply(snapshot)
    const held = this.pending.sort((left, right) => left.seq - right.seq)
    this.pending = []
    for (const frame of held) this.apply(frame)
  }

  /** A live frame; returns whether the screen changed. */
  push(frame: EngineFrame): boolean {
    if (!this.frame) {
      this.pending.push(frame)
      return false
    }
    return this.apply(frame)
  }

  private apply(frame: EngineFrame): boolean {
    if (this.frame && frame.seq <= this.frame.seq) return false
    const resized = !this.frame || frame.rows !== this.frame.rows
    if (frame.full || resized) {
      this.rows = Array.from({ length: frame.rows }, (_, row) => blankLine(row))
    } else {
      this.rows = [...this.rows]
    }
    for (const line of frame.lines) {
      if (line.row >= 0 && line.row < frame.rows) this.rows[line.row] = line
    }
    // A title is only sent when it changes; keep the last one.
    this.frame = { ...frame, title: frame.title ?? this.frame?.title, lines: [] }
    return true
  }

  /** The viewport as plain text, wrapped rows rejoined, trailing blank rows dropped. */
  text(): string {
    const lines: string[] = []
    let continues = false
    for (const row of this.rows) {
      const text = row.runs.map((run) => run.text).join('')
      if (continues && lines.length > 0) lines[lines.length - 1] += text
      else lines.push(text.trimEnd())
      continues = row.wrapped
    }
    return lines.join('\n').trimEnd()
  }
}

function blankLine(row: number): EngineFrameLine {
  return { row, wrapped: false, runs: [] }
}
