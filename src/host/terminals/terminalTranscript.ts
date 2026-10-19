import type { TerminalMark, TerminalOutput, TerminalRuntimeState } from '@core/types.js'
import { TerminalProtocolParser } from './terminalProtocol.js'
import { TerminalRuntime, type TerminalRuntimeEvent } from './terminalRuntime.js'

export const BACKLOG_LIMIT = 200_000

export interface TerminalTranscriptUpdate {
  output: TerminalOutput
  runtimeStates: TerminalRuntimeState[]
}

/**
 * Interprets one PTY's byte stream into terminal output and shell state. It deliberately has no
 * knowledge of a PTY or listeners: ptyManager owns process lifecycle and event delivery.
 */
export class TerminalTranscript {
  private readonly parser = new TerminalProtocolParser()
  private readonly runtime: TerminalRuntime
  private backlogData = ''
  private sequence = 0
  /** Characters of output ever produced; retained mark offsets count from the start of this. */
  private streamLength = 0
  private marks: TerminalMark[] = []

  constructor(sessionId: string, initialCwd: string) {
    this.runtime = new TerminalRuntime(sessionId, initialCwd)
  }

  append(data: string): TerminalTranscriptUpdate {
    const parsed = this.parser.parse(data)
    const chunkStart = this.streamLength
    const marks: TerminalMark[] = []
    const runtimeStates: TerminalRuntimeState[] = []
    let position = chunkStart

    for (const fragment of parsed.fragments) {
      if (fragment.kind === 'terminal') {
        this.runtime.appendOutput(fragment.data)
        position += fragment.data.length
        continue
      }

      const before = this.runtime.snapshot()
      this.runtime.apply(fragment.event)
      const after = this.runtime.snapshot()
      const mark = commandMark(fragment.event, before, after, position)
      if (mark) {
        this.marks.push(mark)
        marks.push({ ...mark, offset: mark.offset - chunkStart })
      }
      runtimeStates.push(after)
    }

    this.streamLength = chunkStart + parsed.terminalData.length
    this.backlogData = (this.backlogData + parsed.terminalData).slice(-BACKLOG_LIMIT)
    this.discardExpiredMarks()
    this.sequence += 1

    return {
      output: { data: parsed.terminalData, sequence: this.sequence, marks },
      runtimeStates
    }
  }

  backlog(): TerminalOutput {
    const start = this.streamLength - this.backlogData.length
    return {
      data: this.backlogData,
      sequence: this.sequence,
      marks: this.marks
        .filter((mark) => mark.offset >= start)
        .map((mark) => ({ ...mark, offset: mark.offset - start }))
    }
  }

  runtimeState(): TerminalRuntimeState {
    return this.runtime.snapshot()
  }

  terminate(exitCode: number): TerminalRuntimeState {
    this.runtime.terminate(exitCode)
    return this.runtime.snapshot()
  }

  private discardExpiredMarks(): void {
    const backlogStart = this.streamLength - this.backlogData.length
    while (this.marks.length > 0 && this.marks[0]!.offset < backlogStart) this.marks.shift()
  }
}

/** The command boundary a runtime event marks, if it marks one. */
function commandMark(
  event: TerminalRuntimeEvent,
  before: TerminalRuntimeState,
  after: TerminalRuntimeState,
  offset: number
): TerminalMark | undefined {
  if (event.type === 'COMMAND_STARTED' && after.runningCommand) {
    const { id, command, startedAt } = after.runningCommand
    return { offset, kind: 'start', id, command, at: startedAt }
  }
  if (event.type === 'COMMAND_FINISHED' && before.runningCommand && after.lastCommand) {
    const { id, endedAt, exitCode } = after.lastCommand
    return { offset, kind: 'end', id, exitCode, at: endedAt ?? Date.now() }
  }
  if (event.type === 'PROMPT_READY') {
    return { offset, kind: 'prompt', id: `prompt-${offset}`, cwd: after.cwd, at: Date.now() }
  }
  return undefined
}
