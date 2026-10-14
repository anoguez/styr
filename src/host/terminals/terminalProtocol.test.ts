import { describe, expect, it } from 'vitest'
import { TerminalProtocolParser } from './terminalProtocol.js'

function field(value: string): string {
  return Buffer.from(value).toString('base64')
}

function event(name: string, ...fields: string[]): string {
  return `\x1b]777;STYR;${name};${fields.map(field).join(';')}\x1b\\`
}

describe('TerminalProtocolParser', () => {
  it('removes a complete Styr event while preserving surrounding terminal output', () => {
    const result = new TerminalProtocolParser().parse(`before${event('CWD_CHANGED', '/repo')}after`)

    expect(result.terminalData).toBe('beforeafter')
    expect(result.fragments).toEqual([
      { kind: 'terminal', data: 'before' },
      { kind: 'event', event: { type: 'CWD_CHANGED', cwd: '/repo' } },
      { kind: 'terminal', data: 'after' }
    ])
  })

  it('frames a Styr sequence split across PTY chunks', () => {
    const parser = new TerminalProtocolParser()
    const sequence = event('COMMAND_STARTED', '/repo', 'pnpm test')

    expect(parser.parse(`hello${sequence.slice(0, 13)}`).terminalData).toBe('hello')
    const result = parser.parse(sequence.slice(13))

    expect(result.terminalData).toBe('')
    expect(result.fragments).toEqual([
      {
        kind: 'event',
        event: { type: 'COMMAND_STARTED', cwd: '/repo', command: 'pnpm test' }
      }
    ])
  })

  it('handles multiple metadata records in one PTY chunk', () => {
    const result = new TerminalProtocolParser().parse(
      `${event('COMMAND_FINISHED', '0')}${event('PROMPT_READY', '/repo')}`
    )

    expect(result.terminalData).toBe('')
    expect(result.fragments).toEqual([
      { kind: 'event', event: { type: 'COMMAND_FINISHED', exitCode: 0 } },
      { kind: 'event', event: { type: 'PROMPT_READY', cwd: '/repo' } }
    ])
  })

  it('passes ordinary ANSI and OSC sequences through unchanged', () => {
    const parser = new TerminalProtocolParser()
    const ansi = '\x1b[31mred\x1b[0m\x1b]0;title\x1b\\'

    expect(parser.parse(ansi).terminalData).toBe(ansi)
  })

  it('keeps malformed Styr metadata on the raw terminal path', () => {
    const malformed = '\x1b]777;STYR;COMMAND_FINISHED;not-base64\x1b\\'

    expect(new TerminalProtocolParser().parse(malformed).terminalData).toBe(malformed)
  })
})
