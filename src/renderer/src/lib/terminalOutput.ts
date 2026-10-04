import type { TerminalMark, TerminalOutput } from '@core/types.js'

export interface TerminalSink {
  write: (data: string) => void
  /** Called once everything written before `mark` has been parsed, so a cursor-relative anchor is exact. */
  mark: (mark: TerminalMark) => void
}

/** Splits `output` at its marks, so each mark lands between the right two pieces of data. */
export function writeOutput(
  sink: TerminalSink,
  output: Pick<TerminalOutput, 'data' | 'marks'>
): void {
  let written = 0
  for (const mark of [...output.marks].sort((left, right) => left.offset - right.offset)) {
    const offset = Math.min(Math.max(mark.offset, written), output.data.length)
    sink.write(output.data.slice(written, offset))
    sink.mark(mark)
    written = offset
  }
  sink.write(output.data.slice(written))
}

/**
 * Combines the terminal's initial backlog with live PTY data without replaying the overlap.
 * PTY output may arrive after the snapshot was requested but before its IPC response returns.
 */
export class TerminalOutputSynchronizer {
  private snapshotSequence: number | null = null
  private pending: TerminalOutput[] = []

  constructor(private readonly sink: TerminalSink) {}

  writeLive(output: TerminalOutput): void {
    if (this.snapshotSequence === null) {
      this.pending.push(output)
      return
    }
    if (output.sequence > this.snapshotSequence) writeOutput(this.sink, output)
  }

  writeBacklog(snapshot: TerminalOutput): void {
    if (this.snapshotSequence !== null) return
    this.snapshotSequence = snapshot.sequence
    if (snapshot.data || snapshot.marks.length > 0) writeOutput(this.sink, snapshot)

    for (const output of this.pending.sort((left, right) => left.sequence - right.sequence)) {
      if (output.sequence > snapshot.sequence) writeOutput(this.sink, output)
    }
    this.pending = []
  }
}
