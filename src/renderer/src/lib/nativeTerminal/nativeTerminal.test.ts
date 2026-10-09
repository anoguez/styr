import { describe, expect, it, vi } from 'vitest'
import type { EngineFrame, EngineFrameLine } from '@core/types.js'
import { ScreenModel } from './screen.js'
import { encodeKey, pasteSequence, type KeyInput } from './keys.js'
import { colourOf, paletteFromTheme, runStyle } from './style.js'
import { EngineChoice } from './engineChoice.js'

function line(row: number, text: string, wrapped = false): EngineFrameLine {
  return { row, wrapped, runs: [{ text, width: text.length, fg: -1, bg: -1, flags: 0 }] }
}

function frame(
  seq: number,
  lines: EngineFrameLine[],
  overrides: Partial<EngineFrame> = {}
): EngineFrame {
  return {
    seq,
    full: false,
    cols: 10,
    rows: 3,
    cursor: { row: 0, col: 0, visible: true, shape: 'block' },
    altScreen: false,
    modes: {
      appCursor: false,
      appKeypad: false,
      bracketedPaste: false,
      focusEvents: false,
      mouse: 'none',
      sgrMouse: false
    },
    historySize: 0,
    displayOffset: 0,
    bell: false,
    lines,
    ...overrides
  }
}

describe('ScreenModel', () => {
  it('builds every row from a full snapshot and patches changed rows after', () => {
    const screen = new ScreenModel()
    screen.reset(frame(1, [line(0, 'one'), line(1, 'two')], { full: true }))
    expect(screen.text()).toBe('one\ntwo')
    screen.push(frame(2, [line(1, 'TWO')]))
    expect(screen.text()).toBe('one\nTWO')
    expect(screen.current?.lines).toHaveLength(3)
  })

  it('holds frames that arrive before the snapshot and drops those it already covers', () => {
    const screen = new ScreenModel()
    expect(screen.push(frame(5, [line(0, 'stale')]))).toBe(false)
    expect(screen.push(frame(7, [line(2, 'newer')]))).toBe(false)
    screen.reset(frame(6, [line(0, 'snap')], { full: true }))
    expect(screen.text()).toBe('snap\n\nnewer')
    expect(screen.current?.seq).toBe(7)
  })

  it('ignores a frame older than the one shown', () => {
    const screen = new ScreenModel()
    screen.reset(frame(3, [line(0, 'now')], { full: true }))
    expect(screen.push(frame(2, [line(0, 'old')]))).toBe(false)
    expect(screen.text()).toBe('now')
  })

  it('clears rows on a full frame or a change of height', () => {
    const screen = new ScreenModel()
    screen.reset(frame(1, [line(0, 'a'), line(1, 'b')], { full: true }))
    screen.push(frame(2, [line(0, 'c')], { rows: 2 }))
    expect(screen.text()).toBe('c')
    expect(screen.current?.lines).toHaveLength(2)
  })

  it('rejoins soft-wrapped rows and keeps the last title', () => {
    const screen = new ScreenModel()
    screen.reset(frame(1, [line(0, 'abcde', true), line(1, 'fg')], { full: true, title: 'vim' }))
    screen.push(frame(2, []))
    expect(screen.text()).toBe('abcdefg')
    expect(screen.current?.title).toBe('vim')
  })

  it('ignores rows outside the screen', () => {
    const screen = new ScreenModel()
    screen.reset(frame(1, [line(9, 'nope'), line(-1, 'nope')], { full: true }))
    expect(screen.text()).toBe('')
  })
})

const key = (name: string, modifiers: Partial<KeyInput> = {}): KeyInput => ({
  key: name,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...modifiers
})
const normal = { modes: { appCursor: false }, altIsMeta: true }
const application = { modes: { appCursor: true }, altIsMeta: true }

describe('encodeKey', () => {
  it('sends printable characters as typed, emoji included', () => {
    expect(encodeKey(key('a'), normal)).toBe('a')
    expect(encodeKey(key('A', { shiftKey: true }), normal)).toBe('A')
    expect(encodeKey(key('😀'), normal)).toBe('😀')
  })

  it('sends C0 control codes for Ctrl+letter', () => {
    expect(encodeKey(key('c', { ctrlKey: true }), normal)).toBe('\x03')
    expect(encodeKey(key('d', { ctrlKey: true }), normal)).toBe('\x04')
    expect(encodeKey(key('[', { ctrlKey: true }), normal)).toBe('\x1b')
    expect(encodeKey(key(' ', { ctrlKey: true }), normal)).toBe('\x00')
    expect(encodeKey(key('/', { ctrlKey: true }), normal)).toBe('\x1f')
    expect(encodeKey(key('?', { ctrlKey: true }), normal)).toBe('\x7f')
    expect(encodeKey(key('1', { ctrlKey: true }), normal)).toBeNull()
  })

  it('follows cursor-key mode for arrows, Home and End', () => {
    expect(encodeKey(key('ArrowUp'), normal)).toBe('\x1b[A')
    expect(encodeKey(key('ArrowUp'), application)).toBe('\x1bOA')
    expect(encodeKey(key('End'), application)).toBe('\x1bOF')
    expect(encodeKey(key('ArrowLeft', { ctrlKey: true }), application)).toBe('\x1b[1;5D')
    expect(encodeKey(key('ArrowRight', { shiftKey: true, altKey: true }), normal)).toBe('\x1b[1;4C')
  })

  it('sends the editing and function keys xterm sends', () => {
    expect(encodeKey(key('Delete'), normal)).toBe('\x1b[3~')
    expect(encodeKey(key('PageUp', { shiftKey: true }), normal)).toBe('\x1b[5;2~')
    expect(encodeKey(key('F1'), normal)).toBe('\x1bOP')
    expect(encodeKey(key('F1', { ctrlKey: true }), normal)).toBe('\x1b[1;5P')
    expect(encodeKey(key('F12'), normal)).toBe('\x1b[24~')
    expect(encodeKey(key('Enter'), normal)).toBe('\r')
    expect(encodeKey(key('Backspace'), normal)).toBe('\x7f')
    expect(encodeKey(key('Backspace', { ctrlKey: true }), normal)).toBe('\x08')
    expect(encodeKey(key('Tab'), normal)).toBe('\t')
    expect(encodeKey(key('Tab', { shiftKey: true }), normal)).toBe('\x1b[Z')
    expect(encodeKey(key('Escape'), normal)).toBe('\x1b')
  })

  it('prefixes ESC for Alt only where Alt is meta', () => {
    expect(encodeKey(key('b', { altKey: true }), normal)).toBe('\x1bb')
    expect(encodeKey(key('å', { altKey: true }), { ...normal, altIsMeta: false })).toBe('å')
  })

  it('sends nothing for ⌘ shortcuts, bare modifiers and dead keys', () => {
    expect(encodeKey(key('c', { metaKey: true }), normal)).toBeNull()
    expect(encodeKey(key('Shift', { shiftKey: true }), normal)).toBeNull()
    expect(encodeKey(key('Dead'), normal)).toBeNull()
    expect(encodeKey(key('Unidentified'), normal)).toBeNull()
  })
})

describe('pasteSequence', () => {
  it('sends newlines as CR', () => {
    expect(pasteSequence('a\nb\r\nc', false)).toBe('a\rb\rc')
  })

  it('brackets a paste when the program asked, and strips a smuggled end marker', () => {
    expect(pasteSequence('ls', true)).toBe('\x1b[200~ls\x1b[201~')
    expect(pasteSequence('a\x1b[201~rm -rf ~\n', true)).toBe('\x1b[200~arm -rf ~\r\x1b[201~')
  })
})

describe('run styles', () => {
  const palette = paletteFromTheme({
    foreground: '#eeeeee',
    background: '#111111',
    red: '#ff0000',
    brightWhite: '#ffffff'
  })

  it('resolves palette, cube, grey and 24-bit colours', () => {
    expect(colourOf(-1, palette)).toBeNull()
    expect(colourOf(1, palette)).toBe('#ff0000')
    expect(colourOf(15, palette)).toBe('#ffffff')
    // An ANSI colour the theme does not set falls back to the foreground.
    expect(colourOf(2, palette)).toBe('#eeeeee')
    expect(colourOf(16, palette)).toBe('#000000')
    expect(colourOf(196, palette)).toBe('#ff0000')
    expect(colourOf(231, palette)).toBe('#ffffff')
    expect(colourOf(232, palette)).toBe('#080808')
    expect(colourOf(255, palette)).toBe('#eeeeee')
    expect(colourOf(0x1000000 + 0x123456, palette)).toBe('#123456')
    expect(colourOf(300, palette)).toBeNull()
  })

  it('swaps colours for inverse against the theme defaults', () => {
    expect(runStyle({ text: 'x', width: 1, fg: -1, bg: -1, flags: 8 }, palette)).toEqual({
      color: '#111111',
      backgroundColor: '#eeeeee'
    })
    expect(runStyle({ text: 'x', width: 1, fg: 1, bg: -1, flags: 8 }, palette)).toEqual({
      color: '#111111',
      backgroundColor: '#ff0000'
    })
  })

  it('maps attribute flags to CSS', () => {
    expect(
      runStyle({ text: 'x', width: 1, fg: -1, bg: -1, flags: 1 | 2 | 4 | 16 | 32 | 64 }, palette)
    ).toEqual({
      fontWeight: 'bold',
      fontStyle: 'italic',
      opacity: 0.6,
      textDecorationLine: 'underline line-through',
      visibility: 'hidden'
    })
    expect(runStyle({ text: 'x', width: 1, fg: -1, bg: -1, flags: 128 }, palette)).toMatchObject({
      textDecorationStyle: 'double'
    })
    expect(runStyle({ text: 'x', width: 1, fg: -1, bg: -1, flags: 256 }, palette)).toMatchObject({
      textDecorationStyle: 'wavy'
    })
  })
})

describe('EngineChoice', () => {
  const info = { apiVersion: 1, packageVersion: '0.1.0', coreVersion: 'x', target: 't' }

  it('wants native only when the setting or the override asks, without waiting', async () => {
    const choice = new EngineChoice({
      availability: async () => ({ supported: true, present: true, override: true }),
      environment: vi.fn()
    })
    expect(choice.wantsNative(false)).toBe(false)
    await choice.availability()
    expect(choice.wantsNative(false)).toBe(true)
  })

  it('loads the environment once, only when selecting', async () => {
    const environment = vi.fn(async () => ({
      status: { available: true as const, info, path: '/p' },
      summary: ''
    }))
    const choice = new EngineChoice({
      availability: async () => ({ supported: true, present: true }),
      environment
    })
    expect(environment).not.toHaveBeenCalled()
    expect((await choice.select(true)).selected).toBe('native')
    expect((await choice.select(true)).selected).toBe('native')
    expect(environment).toHaveBeenCalledTimes(1)
  })

  it('falls back to xterm.js when asking the main process fails', async () => {
    const choice = new EngineChoice({
      availability: async () => {
        throw new Error('no ipc')
      },
      environment: async () => {
        throw new Error('no ipc')
      }
    })
    expect(await choice.availability()).toBeNull()
    expect(choice.wantsNative(false)).toBe(false)
    expect(await choice.select(true)).toMatchObject({
      selected: 'xterm',
      fallbackReason: 'missing-package'
    })
  })
})
