import type { EngineModes } from '@core/types.js'

/**
 * Mouse reporting for the native engine, as xterm encodes it. The engine only says what the program
 * asked for (`modes.mouse`, `modes.sgrMouse`); the view turns pointer events into these bytes and
 * writes them to the PTY like keys.
 */

export type MouseButton = 'left' | 'middle' | 'right' | 'none' | 'wheelUp' | 'wheelDown'

export interface MouseReport {
  kind: 'press' | 'release' | 'move'
  button: MouseButton
  /** 0-based cell, clamped to the screen by the caller. */
  col: number
  row: number
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
}

const BUTTON_CODE: Record<MouseButton, number> = {
  left: 0,
  middle: 1,
  right: 2,
  none: 3,
  wheelUp: 64,
  wheelDown: 65
}

/** The X10 form puts each coordinate in one byte (`32 + n`), so it stops at column/row 223. */
const X10_LIMIT = 223

/** The DOM's `MouseEvent.button` as a reported button; null for back/forward and the like. */
export function mouseButton(button: number): MouseButton | null {
  if (button === 0) return 'left'
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return null
}

/** Whether the program wants pointer events at all; Shift keeps the pointer for selecting text. */
export function reportsMouse(modes: Pick<EngineModes, 'mouse'>, shiftKey: boolean): boolean {
  return modes.mouse !== 'none' && !shiftKey
}

/**
 * The bytes reporting `event`, or null when the program's mode does not ask for it: `click` (1000)
 * wants presses, releases and the wheel; `drag` (1002) also motion with a button held; `motion`
 * (1003) every motion.
 */
export function encodeMouse(
  event: MouseReport,
  modes: Pick<EngineModes, 'mouse' | 'sgrMouse'>
): string | null {
  if (modes.mouse === 'none') return null
  const wheel = event.button === 'wheelUp' || event.button === 'wheelDown'
  if (event.kind === 'move') {
    if (modes.mouse === 'click') return null
    if (modes.mouse === 'drag' && event.button === 'none') return null
  }
  // The wheel has no release.
  if (wheel && event.kind !== 'press') return null

  let code = BUTTON_CODE[event.button]
  if (event.kind === 'move') code += 32
  if (event.shiftKey) code += 4
  if (event.altKey) code += 8
  if (event.ctrlKey) code += 16
  const x = event.col + 1
  const y = event.row + 1

  if (modes.sgrMouse) {
    return `\x1b[<${code};${x};${y}${event.kind === 'release' ? 'm' : 'M'}`
  }
  // X10 cannot say which button went up: every release is button 3.
  if (event.kind === 'release') code = (code & ~3) | 3
  if (x > X10_LIMIT || y > X10_LIMIT) return null
  return `\x1b[M${String.fromCharCode(32 + code, 32 + x, 32 + y)}`
}

/** The 0-based cell under a point `x`, `y` pixels from the grid's top left, kept on the screen. */
export function cellAt(
  x: number,
  y: number,
  cell: { width: number; height: number },
  screen: { cols: number; rows: number }
): { col: number; row: number } {
  const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max - 1)
  return {
    col: clamp(Math.floor(x / cell.width), screen.cols),
    row: clamp(Math.floor(y / cell.height), screen.rows)
  }
}
