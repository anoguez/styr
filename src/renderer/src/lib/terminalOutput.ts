export interface SequencedTerminalOutput {
  sequence: number
  data: string
}

/**
 * Combines the terminal's initial backlog with live PTY data without replaying the overlap.
 * PTY output may arrive after the snapshot was requested but before its IPC response returns.
 */
export class TerminalOutputSynchronizer {
  private snapshotSequence: number | null = null
  private pending: SequencedTerminalOutput[] = []

  constructor(private readonly write: (data: string) => void) {}

  writeLive(output: SequencedTerminalOutput): void {
    if (this.snapshotSequence === null) {
      this.pending.push(output)
      return
    }
    if (output.sequence > this.snapshotSequence) this.write(output.data)
  }

  writeBacklog(snapshot: SequencedTerminalOutput): void {
    if (this.snapshotSequence !== null) return
    this.snapshotSequence = snapshot.sequence
    if (snapshot.data) this.write(snapshot.data)

    for (const output of this.pending.sort((left, right) => left.sequence - right.sequence)) {
      if (output.sequence > snapshot.sequence) this.write(output.data)
    }
    this.pending = []
  }
}
