import { afterEach, describe, expect, it } from 'vitest'
import {
  acceleratorFor,
  commandForEvent,
  formatAccelerator,
  isReserved,
  setPrimaryModifier,
  type ShortcutKeyEvent
} from './shortcuts.js'
import { DEFAULT_SHORTCUTS } from './types.js'

function key(
  name: string,
  modifiers: Partial<Omit<ShortcutKeyEvent, 'key'>> = {}
): ShortcutKeyEvent {
  return { key: name, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...modifiers }
}

const inTerminal = { terminalFocused: true }
const onBoard = { terminalFocused: false }

afterEach(() => setPrimaryModifier('meta'))

describe('on macOS (the default)', () => {
  it('treats Command as mod and Control as itself', () => {
    expect(acceleratorFor(key('t', { metaKey: true }))).toBe('mod+t')
    expect(acceleratorFor(key('c', { ctrlKey: true }))).toBe('ctrl+c')
  })

  it('runs terminal commands on ⌘letter inside the terminal', () => {
    expect(commandForEvent(DEFAULT_SHORTCUTS, key('t', { metaKey: true }), inTerminal)).toBe(
      'newShell'
    )
    expect(commandForEvent(DEFAULT_SHORTCUTS, key('r', { metaKey: true }), inTerminal)).toBe(
      'terminalRetry'
    )
  })

  it('formats with symbols', () => {
    expect(formatAccelerator('mod+shift+n')).toBe('⌘⇧N')
    expect(formatAccelerator('mod+enter')).toBe('⌘↵')
    expect(formatAccelerator('ctrl+c')).toBe('⌃C')
  })

  it('reserves the terminal’s control keys', () => {
    expect(isReserved('ctrl+c')).toBe(true)
    expect(isReserved('mod+c')).toBe(false)
  })
})

describe('where Control is the primary modifier (Windows)', () => {
  it('treats Control as mod', () => {
    setPrimaryModifier('ctrl')
    expect(acceleratorFor(key('n', { ctrlKey: true }))).toBe('mod+n')
    expect(acceleratorFor(key('n', { metaKey: true }))).toBe('meta+n')
  })

  it('runs window commands on Ctrl+letter outside the terminal', () => {
    setPrimaryModifier('ctrl')
    expect(commandForEvent(DEFAULT_SHORTCUTS, key('n', { ctrlKey: true }), onBoard)).toBe('newTask')
  })

  it('leaves Ctrl+letter to the shell inside the terminal', () => {
    setPrimaryModifier('ctrl')
    for (const letter of ['r', 'd', 'l', 'w', 'p', 'k']) {
      expect(commandForEvent(DEFAULT_SHORTCUTS, key(letter, { ctrlKey: true }), inTerminal)).toBe(
        null
      )
    }
  })

  it('reaches a terminal command with Ctrl+Shift+letter', () => {
    setPrimaryModifier('ctrl')
    const shifted = (letter: string): ShortcutKeyEvent =>
      key(letter.toUpperCase(), { ctrlKey: true, shiftKey: true })
    expect(commandForEvent(DEFAULT_SHORTCUTS, shifted('t'), inTerminal)).toBe('newShell')
    expect(commandForEvent(DEFAULT_SHORTCUTS, shifted('r'), inTerminal)).toBe('terminalRetry')
    // A command bound to Ctrl+Shift+letter itself keeps it.
    expect(commandForEvent(DEFAULT_SHORTCUTS, shifted('c'), inTerminal)).toBe('terminalCopyOutput')
    expect(commandForEvent(DEFAULT_SHORTCUTS, shifted('p'), inTerminal)).toBe('commandPalette')
  })

  it('still runs non-letter combinations in the terminal', () => {
    setPrimaryModifier('ctrl')
    expect(commandForEvent(DEFAULT_SHORTCUTS, key('1', { ctrlKey: true }), inTerminal)).toBe(
      'terminalTab1'
    )
    expect(commandForEvent(DEFAULT_SHORTCUTS, key('`', { ctrlKey: true }), inTerminal)).toBe(
      'toggleTerminal'
    )
  })

  it('formats with words', () => {
    setPrimaryModifier('ctrl')
    expect(formatAccelerator('mod+shift+n')).toBe('Ctrl+Shift+N')
    expect(formatAccelerator('mod+enter')).toBe('Ctrl+Enter')
    expect(formatAccelerator('ctrl+c')).toBe('Ctrl+C')
  })

  it('reserves Ctrl+C even though it is recorded as mod+c', () => {
    setPrimaryModifier('ctrl')
    expect(isReserved('mod+c')).toBe(true)
    expect(isReserved('mod+n')).toBe(false)
  })
})
