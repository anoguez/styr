import type { TerminalMark, TrackedBlock } from '@core/types.js'
import type { NativeTerminalEngine } from './nativeEngine.js'

type MarkingEngine = Required<
  Pick<NativeTerminalEngine, 'cursorPosition' | 'markLine' | 'markedLines'>
>

/**
 * Tracks shell command marks against an engine's buffer. The engine owns line positions while this
 * module owns the command lifecycle and turns that state into the block snapshots the renderer
 * consumes.
 */
export class CommandBlockTracker {
  private readonly commands = new Map<string, Command>()

  private constructor(private readonly engine: MarkingEngine) {}

  /** Returns no tracker when the installed engine predates command mark support. */
  static create(engine: NativeTerminalEngine): CommandBlockTracker | undefined {
    return supportsMarks(engine) ? new CommandBlockTracker(engine) : undefined
  }

  /** Observes a mark after the output before it has been written to the engine. */
  observe(mark: TerminalMark): void {
    if (mark.kind === 'prompt') return
    if (mark.kind === 'start') {
      // The shell announces a command after Enter has moved the cursor down, so its own row is the
      // one above. No mark (the alternate screen, say) means no block.
      if (this.engine.markLine(mark.id, -1) === null) return
      this.commands.set(mark.id, { command: mark.command ?? '', startedAt: mark.at })
      return
    }

    const command = this.commands.get(mark.id)
    if (!command || command.endedAt !== undefined) return
    const start = this.engine.markedLines().find((line) => line.id === mark.id)
    if (!start) {
      this.commands.delete(mark.id)
      return
    }
    const cursor = this.engine.cursorPosition()
    // Output without a final newline leaves the cursor on its last row, which then belongs to it.
    const end = cursor.line + (cursor.col > 0 ? 1 : 0)
    command.span = Math.max(1, end - start.line)
    command.endedAt = mark.at
    command.exitCode = mark.exitCode
  }

  /**
   * Returns the current block snapshot. Commands whose marked line left the buffer are forgotten,
   * keeping tracking bounded by the engine's scrollback.
   */
  snapshot(): TrackedBlock[] {
    if (this.commands.size === 0) return []
    const marked = new Map(this.engine.markedLines().map((line) => [line.id, line.line]))
    const cursor = this.engine.cursorPosition()
    const blocks: TrackedBlock[] = []
    for (const [id, command] of this.commands) {
      const startLine = marked.get(id)
      if (startLine === undefined) {
        this.commands.delete(id)
        continue
      }
      const open = command.span === undefined
      const endLine = open
        ? cursor.line + (cursor.col > 0 ? 1 : 0)
        : startLine + (command.span ?? 1)
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
}

interface Command {
  command: string
  startedAt: number
  endedAt?: number
  exitCode?: number
  /** Lines from the command's row to just past its output, fixed when it ends. */
  span?: number
}

function supportsMarks(
  engine: NativeTerminalEngine
): engine is NativeTerminalEngine & MarkingEngine {
  return (
    typeof engine.markLine === 'function' &&
    typeof engine.markedLines === 'function' &&
    typeof engine.cursorPosition === 'function'
  )
}
