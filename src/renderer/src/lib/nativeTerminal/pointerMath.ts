import type { BufferPoint, GridSelection } from './selection.js'

/**
 * Wheel movement as whole lines. A trackpad sends deltas smaller than a line, so what does not
 * make a whole line is carried to the next event (in pixels, as it came).
 */
export function wheelLines(
  deltaY: number,
  remainder: number,
  lineHeight: number
): { whole: number; remainder: number } {
  const lines = (deltaY + remainder) / lineHeight
  const whole = Math.trunc(lines)
  return { whole, remainder: (lines - whole) * lineHeight }
}

/** A press's selection unit from its click count: double picks a word, triple a line. */
export function selectionUnit(detail: number): GridSelection['unit'] {
  return detail >= 3 ? 'line' : detail === 2 ? 'word' : 'cell'
}

/**
 * The selection a press at `at` starts. With Shift and a selection already there it keeps that
 * one's anchor and unit and moves the head; otherwise it starts fresh from the click count.
 */
export function startSelection(
  at: BufferPoint,
  detail: number,
  shiftKey: boolean,
  previous: GridSelection | null
): GridSelection {
  const extend = shiftKey ? previous : null
  return {
    anchor: extend ? extend.anchor : at,
    head: at,
    unit: extend ? extend.unit : selectionUnit(detail)
  }
}

/** The text a file drop pastes: each path quoted for the shell, with a space after the last. */
export function droppedText(paths: readonly string[], quote: (path: string) => string): string {
  return paths.map((path) => quote(path)).join(' ') + ' '
}
