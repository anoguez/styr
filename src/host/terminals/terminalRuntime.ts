import { nanoid } from 'nanoid'
import type { TerminalCommand, TerminalRuntimeState } from '@core/types.js'

const COMMAND_OUTPUT_LIMIT = 100_000

export type TerminalRuntimeEvent =
  | { type: 'CWD_CHANGED'; cwd: string }
  | { type: 'PROMPT_READY'; cwd: string }
  | { type: 'COMMAND_STARTED'; cwd: string; command: string }
  | { type: 'COMMAND_FINISHED'; exitCode: number }

/** Main-process authority for semantic shell state and bounded command output. */
export class TerminalRuntime {
  private state: TerminalRuntimeState
  private runningOutput = ''

  constructor(sessionId: string, initialCwd: string) {
    this.state = { sessionId, cwd: initialCwd, promptReady: false }
  }

  snapshot(): TerminalRuntimeState {
    return {
      ...this.state,
      ...(this.state.runningCommand ? { runningCommand: { ...this.state.runningCommand } } : {}),
      ...(this.state.lastCommand ? { lastCommand: { ...this.state.lastCommand } } : {})
    }
  }

  appendOutput(data: string): void {
    if (!this.state.runningCommand || !data) return
    this.runningOutput = (this.runningOutput + data).slice(-COMMAND_OUTPUT_LIMIT)
  }

  apply(event: TerminalRuntimeEvent): void {
    switch (event.type) {
      case 'CWD_CHANGED':
        this.state.cwd = event.cwd
        return
      case 'PROMPT_READY':
        this.state.cwd = event.cwd
        this.state.promptReady = true
        return
      case 'COMMAND_STARTED':
        this.state.cwd = event.cwd
        this.state.promptReady = false
        this.runningOutput = ''
        this.state.runningCommand = {
          id: nanoid(10),
          command: event.command,
          cwd: event.cwd,
          startedAt: Date.now()
        }
        return
      case 'COMMAND_FINISHED':
        this.finishCommand(event.exitCode)
    }
  }

  terminate(exitCode: number): void {
    this.finishCommand(exitCode)
    this.state.promptReady = false
    this.state.terminated = true
    this.state.lastExitCode = exitCode
  }

  private finishCommand(exitCode: number): void {
    const running = this.state.runningCommand
    if (running) {
      const command: TerminalCommand = {
        ...running,
        endedAt: Date.now(),
        exitCode,
        ...(this.runningOutput ? { output: this.runningOutput } : {})
      }
      this.state.lastCommand = command
      this.state.runningCommand = undefined
      this.runningOutput = ''
    }
    this.state.lastExitCode = exitCode
  }
}
