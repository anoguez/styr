import { describe, expect, it } from 'vitest'
import { TerminalRuntime } from './terminalRuntime.js'

describe('TerminalRuntime', () => {
  it('tracks cwd, commands, bounded output, exit status, and prompt readiness', () => {
    const runtime = new TerminalRuntime('session-1', '/initial')

    runtime.apply({ type: 'CWD_CHANGED', cwd: '/repo' })
    runtime.apply({ type: 'PROMPT_READY', cwd: '/repo' })
    runtime.apply({ type: 'COMMAND_STARTED', cwd: '/repo', command: 'git status' })
    runtime.appendOutput('On branch main\n')
    runtime.apply({ type: 'COMMAND_FINISHED', exitCode: 0 })
    runtime.apply({ type: 'PROMPT_READY', cwd: '/repo' })

    expect(runtime.snapshot()).toMatchObject({
      sessionId: 'session-1',
      cwd: '/repo',
      promptReady: true,
      lastExitCode: 0,
      lastCommand: { command: 'git status', cwd: '/repo', exitCode: 0, output: 'On branch main\n' }
    })
  })

  it('finishes an in-flight command when its shell exits unexpectedly', () => {
    const runtime = new TerminalRuntime('session-1', '/repo')
    runtime.apply({ type: 'COMMAND_STARTED', cwd: '/repo', command: 'long-running' })
    runtime.appendOutput('partial output')
    runtime.terminate(143)

    expect(runtime.snapshot()).toMatchObject({
      promptReady: false,
      terminated: true,
      lastExitCode: 143,
      lastCommand: { command: 'long-running', exitCode: 143, output: 'partial output' }
    })
  })
})
