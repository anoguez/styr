import { afterEach, describe, expect, it } from 'vitest'
import { setPrimaryModifier } from '@core/shortcuts.js'
import { clipboardKey, type ModifierKeyEvent } from './terminalKeys.js'

function keydown(key: string, modifiers: Partial<ModifierKeyEvent> = {}): ModifierKeyEvent {
  return {
    type: 'keydown',
    key,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...modifiers
  }
}

afterEach(() => setPrimaryModifier('meta'))

describe('clipboardKey', () => {
  it('never claims a key on macOS, where ⌘C and ⌘V do not reach the shell', () => {
    expect(clipboardKey(keydown('c', { ctrlKey: true }), true)).toBe(null)
    expect(clipboardKey(keydown('v', { ctrlKey: true }), false)).toBe(null)
  })

  it('copies on Ctrl+C only when text is selected on Windows', () => {
    setPrimaryModifier('ctrl')
    expect(clipboardKey(keydown('c', { ctrlKey: true }), true)).toBe('copy')
    expect(clipboardKey(keydown('c', { ctrlKey: true }), false)).toBe(null)
  })

  it('pastes on Ctrl+V and Ctrl+Shift+V on Windows', () => {
    setPrimaryModifier('ctrl')
    expect(clipboardKey(keydown('v', { ctrlKey: true }), false)).toBe('paste')
    expect(clipboardKey(keydown('V', { ctrlKey: true, shiftKey: true }), false)).toBe('paste')
    expect(clipboardKey({ ...keydown('v', { ctrlKey: true }), type: 'keyup' }, false)).toBe(null)
  })
})
