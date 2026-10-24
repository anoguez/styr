import { describe, expect, it } from 'vitest'
import { droppedText, selectionUnit, startSelection, wheelLines } from './pointerMath.js'
import type { GridSelection } from './selection.js'

describe('wheelLines', () => {
  it('turns a delta into whole lines', () => {
    expect(wheelLines(40, 0, 20)).toEqual({ whole: 2, remainder: 0 })
  })

  it('carries what is less than a line to the next event', () => {
    const first = wheelLines(8, 0, 20)
    expect(first).toEqual({ whole: 0, remainder: 8 })
    const second = wheelLines(8, first.remainder, 20)
    expect(second.whole).toBe(0)
    expect(second.remainder).toBe(16)
    const third = wheelLines(8, second.remainder, 20)
    expect(third.whole).toBe(1)
    expect(third.remainder).toBeCloseTo(4)
  })

  it('handles negative deltas, truncating toward zero', () => {
    expect(wheelLines(-50, 0, 20)).toEqual({ whole: -2, remainder: -10 })
    expect(wheelLines(-5, 0, 20)).toEqual({ whole: -0, remainder: -5 })
  })

  it('handles fractional deltas', () => {
    const result = wheelLines(2.5, 0, 10)
    expect(result.whole).toBe(0)
    expect(result.remainder).toBeCloseTo(2.5)
  })

  it('opposes the carried remainder', () => {
    expect(wheelLines(-10, 15, 20)).toEqual({ whole: 0, remainder: 5 })
  })
})

describe('selectionUnit', () => {
  it('follows the click count', () => {
    expect(selectionUnit(1)).toBe('cell')
    expect(selectionUnit(0)).toBe('cell')
    expect(selectionUnit(2)).toBe('word')
    expect(selectionUnit(3)).toBe('line')
    expect(selectionUnit(5)).toBe('line')
  })
})

describe('startSelection', () => {
  const at = { line: 10, col: 4 }
  const previous: GridSelection = {
    anchor: { line: 2, col: 1 },
    head: { line: 3, col: 3 },
    unit: 'word'
  }

  it('starts fresh at the click, by its unit', () => {
    expect(startSelection(at, 1, false, previous)).toEqual({ anchor: at, head: at, unit: 'cell' })
    expect(startSelection(at, 2, false, null).unit).toBe('word')
    expect(startSelection(at, 3, false, null).unit).toBe('line')
  })

  it('with Shift keeps the old anchor and unit and moves the head', () => {
    expect(startSelection(at, 1, true, previous)).toEqual({
      anchor: previous.anchor,
      head: at,
      unit: 'word'
    })
  })

  it('with Shift and no selection starts fresh', () => {
    expect(startSelection(at, 2, true, null)).toEqual({ anchor: at, head: at, unit: 'word' })
  })
})

describe('droppedText', () => {
  const quote = (path: string): string => `'${path}'`

  it('quotes each path and ends with a space', () => {
    expect(droppedText(['/a b', '/c'], quote)).toBe("'/a b' '/c' ")
  })

  it('ends with a space for one path', () => {
    expect(droppedText(['/a'], quote)).toBe("'/a' ")
  })
})
