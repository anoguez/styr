import type { TerminalMark, TerminalOutput } from '@core/types.js'
import { BACKLOG_LIMIT } from '../terminals/terminalTranscript.js'

/**
 * The client's copy of a remote terminal's output since it attached: the server's backlog, then
 * the live stream, bounded like `TerminalTranscript`. The Styr Terminal engine draws on the client
 * and asks for a backlog synchronously (`NativeHostPorts.backlog`), so it reads this rather than
 * waiting on the network. Marks are kept with offsets into `data`.
 */
export class TerminalMirror {
  private data = ''
  private marks: TerminalMark[] = []
  private sequence = 0

  constructor(backlog: TerminalOutput) {
    this.reset(backlog)
  }

  /** Starts again from a fresh backlog (a reattach). */
  reset(backlog: TerminalOutput): void {
    this.data = ''
    this.marks = []
    this.sequence = backlog.sequence
    this.add(backlog)
  }

  /** Live output; a chunk the backlog already held (same or older sequence) is skipped. */
  append(output: TerminalOutput): boolean {
    if (output.sequence <= this.sequence) return false
    this.sequence = output.sequence
    this.add(output)
    return true
  }

  get lastSequence(): number {
    return this.sequence
  }

  backlog(): TerminalOutput {
    return {
      data: this.data,
      sequence: this.sequence,
      marks: this.marks.map((mark) => ({ ...mark }))
    }
  }

  private add(output: Pick<TerminalOutput, 'data' | 'marks'>): void {
    const base = this.data.length
    this.data += output.data
    for (const mark of output.marks) this.marks.push({ ...mark, offset: base + mark.offset })
    const excess = this.data.length - BACKLOG_LIMIT
    if (excess <= 0) return
    this.data = this.data.slice(excess)
    this.marks = this.marks
      .filter((mark) => mark.offset >= excess)
      .map((mark) => ({ ...mark, offset: mark.offset - excess }))
  }
}
