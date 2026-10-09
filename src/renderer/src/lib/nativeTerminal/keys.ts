import type { EngineModes } from '@core/types.js'

export interface KeyInput {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export interface KeyOptions {
  modes: Pick<EngineModes, 'appCursor'>
  /**
   * Whether Alt/Option prefixes ESC (meta). Off on macOS, as in xterm.js's default there: Option
   * types the composed character (Option+e then e is "é"), which `key` already holds.
   */
  altIsMeta: boolean
}

const CURSOR: Record<string, string> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
  Home: 'H',
  End: 'F'
}

const TILDE: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24
}

const SS3_FUNCTION: Record<string, string> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' }

/** xterm's modifier parameter: 1 + Shift + 2·Alt + 4·Ctrl; 1 alone means no modifier. */
function modifierParam(input: KeyInput): number {
  return 1 + (input.shiftKey ? 1 : 0) + (input.altKey ? 2 : 0) + (input.ctrlKey ? 4 : 0)
}

/** Ctrl with a character: the C0 control code a VT100 keyboard sends, or null when there is none. */
function controlCode(key: string): string | null {
  if (key === ' ' || key === '@' || key === '2') return '\x00'
  if (key === '?' || key === '8') return '\x7f'
  const code = key.toUpperCase().charCodeAt(0)
  // @ A..Z [ \ ] ^ _
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f)
  if (key === '3') return '\x1b'
  if (key === '4') return '\x1c'
  if (key === '5') return '\x1d'
  if (key === '6') return '\x1e'
  if (key === '7' || key === '/' || key === '-') return '\x1f'
  return null
}

/**
 * The bytes a key sends to the PTY, following xterm's conventions so shells and TUIs read it the
 * way they read xterm.js. Null means the key sends nothing (a bare modifier, a ⌘ shortcut, a dead
 * key) and should be left to the browser. Pure: no DOM, no engine.
 */
export function encodeKey(input: KeyInput, options: KeyOptions): string | null {
  const { key } = input
  if (input.metaKey) return null
  const meta = input.altKey && options.altIsMeta ? '\x1b' : ''
  const modifier = modifierParam(input)

  if (key in CURSOR) {
    const final = CURSOR[key]!
    if (modifier > 1) return `\x1b[1;${modifier}${final}`
    return options.modes.appCursor ? `\x1bO${final}` : `\x1b[${final}`
  }
  if (key in TILDE) {
    const code = TILDE[key]!
    return modifier > 1 ? `\x1b[${code};${modifier}~` : `\x1b[${code}~`
  }
  if (key in SS3_FUNCTION) {
    const final = SS3_FUNCTION[key]!
    return modifier > 1 ? `\x1b[1;${modifier}${final}` : `\x1bO${final}`
  }
  switch (key) {
    case 'Enter':
      return `${meta}\r`
    case 'Backspace':
      return input.ctrlKey ? `${meta}\x08` : `${meta}\x7f`
    case 'Tab':
      return input.shiftKey ? '\x1b[Z' : `${meta}\t`
    case 'Escape':
      return `${meta}\x1b`
  }
  // A printable key: one character, or one grapheme (an emoji from an input source).
  if ([...key].length !== 1) return null
  if (input.ctrlKey) {
    const control = controlCode(key)
    return control === null ? null : `${meta}${control}`
  }
  return `${meta}${key}`
}

/** Bracketed paste wraps pasted text so a shell or editor does not run it line by line. */
export function pasteSequence(text: string, bracketed: boolean): string {
  // A newline is sent as CR, as typed; and a pasted end marker must not end the paste early.
  const normalised = text.replace(/\r?\n/g, '\r')
  if (!bracketed) return normalised
  return `\x1b[200~${normalised.replaceAll('\x1b[201~', '')}\x1b[201~`
}
