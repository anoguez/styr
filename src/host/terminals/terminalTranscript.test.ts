import { describe, expect, it } from 'vitest'
import { TerminalTranscript } from './terminalTranscript.js'

function field(value: string): string {
  return Buffer.from(value).toString('base64')
}

function event(name: string, ...fields: string[]): string {
  return `\x1b]777;STYR;${name};${fields.map(field).join(';')}\x1b\\`
}

describe('TerminalTranscript', () => {
  it('interprets chunked protocol input while preserving output sequencing and mark offsets', () => {
    const transcript = new TerminalTranscript('session-1', '/initial')
    const started = event('COMMAND_STARTED', '/repo', 'yarn test')

    expect(transcript.append(`before${started.slice(0, 13)}`)).toEqual({
      output: { data: 'before', sequence: 1, marks: [] },
      runtimeStates: []
    })

    const running = transcript.append(`${started.slice(13)}result`)
    expect(running.output).toMatchObject({ data: 'result', sequence: 2 })
    expect(running.output.marks).toMatchObject([{ kind: 'start', offset: 0, command: 'yarn test' }])
    expect(running.runtimeStates).toHaveLength(1)
    expect(transcript.runtimeState()).toMatchObject({
      sessionId: 'session-1',
      cwd: '/repo',
      promptReady: false,
      runningCommand: { command: 'yarn test' }
    })

    const completed = transcript.append(
      `tail${event('COMMAND_FINISHED', '0')}${event('PROMPT_READY', '/repo')}`
    )
    expect(completed.output).toMatchObject({ data: 'tail', sequence: 3 })
    expect(completed.output.marks).toMatchObject([
      { kind: 'end', offset: 4, exitCode: 0 },
      { kind: 'prompt', offset: 4, cwd: '/repo' }
    ])
    expect(completed.runtimeStates).toHaveLength(2)
    expect(transcript.runtimeState()).toMatchObject({
      promptReady: true,
      lastExitCode: 0,
      lastCommand: { command: 'yarn test', output: 'resulttail', exitCode: 0 }
    })
  })

  it('returns a bounded backlog snapshot and retains terminal state after exit', () => {
    const transcript = new TerminalTranscript('session-1', '/repo')
    transcript.append('a'.repeat(200_000))
    transcript.append('tail')

    expect(transcript.backlog()).toEqual({
      data: `${'a'.repeat(199_996)}tail`,
      sequence: 2,
      marks: []
    })
    expect(transcript.terminate(143)).toMatchObject({
      sessionId: 'session-1',
      terminated: true,
      promptReady: false,
      lastExitCode: 143
    })
  })
})
