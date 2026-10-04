import type { TerminalRuntimeEvent } from './terminalRuntime.js'

const MARKER = '\x1b]777;STYR;'
const STRING_TERMINATOR = '\x1b\\'
const MAX_PENDING_SEQUENCE_LENGTH = 16_384

export type TerminalProtocolFragment =
  { kind: 'terminal'; data: string } | { kind: 'event'; event: TerminalRuntimeEvent }

export interface TerminalProtocolParseResult {
  terminalData: string
  fragments: TerminalProtocolFragment[]
}

/**
 * Separates Styr's private OSC records from a PTY stream without interpreting any other terminal
 * control sequences. Only a complete, valid Styr record is removed; malformed data stays on the
 * raw path so terminal compatibility always wins.
 */
export class TerminalProtocolParser {
  private pending = ''

  parse(data: string): TerminalProtocolParseResult {
    let remaining = this.pending + data
    this.pending = ''
    const fragments: TerminalProtocolFragment[] = []

    const appendTerminal = (terminalData: string): void => {
      if (!terminalData) return
      const previous = fragments.at(-1)
      if (previous?.kind === 'terminal') previous.data += terminalData
      else fragments.push({ kind: 'terminal', data: terminalData })
    }

    while (remaining) {
      const escapeIndex = remaining.indexOf('\x1b')
      if (escapeIndex === -1) {
        appendTerminal(remaining)
        break
      }

      appendTerminal(remaining.slice(0, escapeIndex))
      remaining = remaining.slice(escapeIndex)

      // Hold only a possible prefix of Styr's marker. All other ANSI and OSC sequences flow
      // through untouched, including ordinary OSC records split across PTY chunks.
      if (MARKER.startsWith(remaining)) {
        this.pending = remaining
        break
      }
      if (!remaining.startsWith(MARKER)) {
        appendTerminal(remaining[0]!)
        remaining = remaining.slice(1)
        continue
      }

      const terminatorIndex = remaining.indexOf(STRING_TERMINATOR, MARKER.length)
      if (terminatorIndex === -1) {
        if (remaining.length > MAX_PENDING_SEQUENCE_LENGTH) appendTerminal(remaining)
        else this.pending = remaining
        break
      }

      const sequenceEnd = terminatorIndex + STRING_TERMINATOR.length
      const sequence = remaining.slice(0, sequenceEnd)
      const event = parseEvent(remaining.slice(MARKER.length, terminatorIndex))
      if (event) fragments.push({ kind: 'event', event })
      else appendTerminal(sequence)
      remaining = remaining.slice(sequenceEnd)
    }

    return {
      terminalData: fragments
        .filter(
          (fragment): fragment is Extract<TerminalProtocolFragment, { kind: 'terminal' }> =>
            fragment.kind === 'terminal'
        )
        .map((fragment) => fragment.data)
        .join(''),
      fragments
    }
  }
}

function parseEvent(value: string): TerminalRuntimeEvent | undefined {
  const [name, ...fields] = value.split(';')
  switch (name) {
    case 'CWD_CHANGED': {
      const cwd = fields.length === 1 ? decodeField(fields[0]) : undefined
      return cwd === undefined ? undefined : { type: 'CWD_CHANGED', cwd }
    }
    case 'PROMPT_READY': {
      const cwd = fields.length === 1 ? decodeField(fields[0]) : undefined
      return cwd === undefined ? undefined : { type: 'PROMPT_READY', cwd }
    }
    case 'COMMAND_STARTED': {
      const cwd = fields.length === 2 ? decodeField(fields[0]) : undefined
      const command = fields.length === 2 ? decodeField(fields[1]) : undefined
      return cwd === undefined || command === undefined
        ? undefined
        : { type: 'COMMAND_STARTED', cwd, command }
    }
    case 'COMMAND_FINISHED': {
      const exitCodeValue = fields.length === 1 ? decodeField(fields[0]) : undefined
      const exitCode = exitCodeValue && /^-?\d+$/.test(exitCodeValue) ? Number(exitCodeValue) : NaN
      return Number.isSafeInteger(exitCode) ? { type: 'COMMAND_FINISHED', exitCode } : undefined
    }
    default:
      return undefined
  }
}

function decodeField(value: string | undefined): string | undefined {
  if (value === undefined || !isBase64(value)) return undefined
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

function isBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
}
