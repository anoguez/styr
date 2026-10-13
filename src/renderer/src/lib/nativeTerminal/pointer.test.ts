import { describe, expect, it } from 'vitest'
import type { EngineFrameLine, EngineModes, EngineRun } from '@core/types.js'
import { cellAt, encodeMouse, mouseButton, reportsMouse, type MouseReport } from './mouse.js'
import { rowCells, runCells } from './cells.js'
import { findUrls, isOpenableLink, linkRows } from './links.js'
import {
  isEmptySelection,
  selectionSpans,
  selectionText,
  wordAt,
  type GridSelection
} from './selection.js'

const run = (text: string, extra: Partial<EngineRun> = {}): EngineRun => ({
  text,
  width: text.length,
  fg: -1,
  bg: -1,
  flags: 0,
  ...extra
})
const row = (index: number, runs: EngineRun[], wrapped = false): EngineFrameLine => ({
  row: index,
  wrapped,
  runs
})

type Modes = Pick<EngineModes, 'mouse' | 'sgrMouse'>
const report = (overrides: Partial<MouseReport>): MouseReport => ({
  kind: 'press',
  button: 'left',
  col: 0,
  row: 0,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  ...overrides
})

describe('mouse reporting', () => {
  const sgr: Modes = { mouse: 'click', sgrMouse: true }
  const x10: Modes = { mouse: 'click', sgrMouse: false }

  it('reports nothing when the program did not ask', () => {
    expect(encodeMouse(report({}), { mouse: 'none', sgrMouse: true })).toBeNull()
    expect(reportsMouse({ mouse: 'none' }, false)).toBe(false)
  })

  it('leaves the pointer to selection while Shift is held', () => {
    expect(reportsMouse({ mouse: 'drag' }, true)).toBe(false)
    expect(reportsMouse({ mouse: 'drag' }, false)).toBe(true)
  })

  it('encodes presses and releases in SGR with 1-based cells', () => {
    expect(encodeMouse(report({ col: 4, row: 2 }), sgr)).toBe('\x1b[<0;5;3M')
    expect(encodeMouse(report({ kind: 'release', col: 4, row: 2 }), sgr)).toBe('\x1b[<0;5;3m')
    expect(encodeMouse(report({ button: 'right' }), sgr)).toBe('\x1b[<2;1;1M')
  })

  it('adds modifiers and the motion bit', () => {
    const drag: Modes = { mouse: 'drag', sgrMouse: true }
    expect(encodeMouse(report({ ctrlKey: true, altKey: true }), sgr)).toBe('\x1b[<24;1;1M')
    expect(encodeMouse(report({ kind: 'move', col: 1 }), drag)).toBe('\x1b[<32;2;1M')
  })

  it('sends motion only in the modes that ask for it', () => {
    const move = report({ kind: 'move', button: 'none' })
    expect(encodeMouse(report({ kind: 'move' }), sgr)).toBeNull()
    expect(encodeMouse(move, { mouse: 'drag', sgrMouse: true })).toBeNull()
    expect(encodeMouse(move, { mouse: 'motion', sgrMouse: true })).toBe('\x1b[<35;1;1M')
  })

  it('encodes the wheel as buttons 64 and 65, presses only', () => {
    expect(encodeMouse(report({ button: 'wheelUp' }), sgr)).toBe('\x1b[<64;1;1M')
    expect(encodeMouse(report({ button: 'wheelDown' }), x10)).toBe('\x1b[M\x61\x21\x21')
    expect(encodeMouse(report({ kind: 'release', button: 'wheelUp' }), sgr)).toBeNull()
  })

  it('uses the X10 form without SGR, every release as button 3, up to cell 223', () => {
    expect(encodeMouse(report({ col: 9, row: 4 }), x10)).toBe('\x1b[M\x20\x2a\x25')
    expect(encodeMouse(report({ kind: 'release', button: 'right' }), x10)).toBe(
      '\x1b[M\x23\x21\x21'
    )
    expect(encodeMouse(report({ col: 222 }), x10)).toBe(`\x1b[M\x20${String.fromCharCode(255)}\x21`)
    expect(encodeMouse(report({ col: 223 }), x10)).toBeNull()
    expect(encodeMouse(report({ col: 300 }), sgr)).toBe('\x1b[<0;301;1M')
  })

  it('maps DOM buttons and points to cells kept on the screen', () => {
    expect([0, 1, 2, 3].map(mouseButton)).toEqual(['left', 'middle', 'right', null])
    const cell = { width: 8, height: 16 }
    const screen = { cols: 80, rows: 24 }
    expect(cellAt(17, 33, cell, screen)).toEqual({ col: 2, row: 2 })
    expect(cellAt(-5, 9999, cell, screen)).toEqual({ col: 0, row: 23 })
  })
})

describe('cells', () => {
  it('gives each cell its character, a wide one two cells', () => {
    expect(runCells(run('ab'))).toEqual(['a', 'b'])
    expect(runCells({ ...run('日本'), width: 4 })).toEqual(['日', '', '本', ''])
    expect(runCells({ ...run('a🙂'), width: 3 })).toEqual(['a', '🙂', ''])
  })

  it('always returns as many cells as the run covers', () => {
    expect(runCells({ ...run('abc'), width: 2 })).toHaveLength(2)
    expect(runCells({ ...run('a'), width: 3 })).toEqual(['a', '', ''])
  })

  it('carries a run’s link onto its cells', () => {
    const cells = rowCells(row(0, [run('a'), run('b', { link: 'https://x' })]))
    expect(cells).toEqual([
      { text: 'a', run: 0 },
      { text: 'b', run: 1, link: 'https://x' }
    ])
  })
})

describe('links', () => {
  it('finds web URLs and leaves out trailing punctuation', () => {
    expect(findUrls('see https://example.com/a.')).toEqual([
      { start: 4, end: 25, url: 'https://example.com/a' }
    ])
    expect(findUrls('(http://x.dev/p_(1))').map((found) => found.url)).toEqual([
      'http://x.dev/p_(1)'
    ])
    expect(findUrls('ftp://x https:// file:///etc')).toEqual([])
    // A backslash is never part of a URL (escapes printed literally, Windows paths).
    expect(findUrls('https://a.io/x\\e]8;;').map((found) => found.url)).toEqual(['https://a.io/x'])
  })

  it('opens only web links', () => {
    expect(isOpenableLink('https://example.com')).toBe(true)
    expect(isOpenableLink('file:///etc/passwd')).toBe(false)
    expect(isOpenableLink('javascript:alert(1)')).toBe(false)
    expect(isOpenableLink(undefined)).toBe(false)
  })

  it('splits runs where a URL starts and ends', () => {
    const [linked] = linkRows([row(0, [run('go https://a.io now', { fg: 2 })])], 40)
    expect(linked!.runs.map((piece) => [piece.text, piece.link ?? null, piece.fg])).toEqual([
      ['go ', null, 2],
      ['https://a.io', 'https://a.io', 2],
      [' now', null, 2]
    ])
  })

  it('finds a URL across a soft wrap', () => {
    const rows = linkRows([row(0, [run('x https://a.')], true), row(1, [run('io/b y')])], 12)
    expect(rows[0]!.runs.at(-1)).toMatchObject({ text: 'https://a.', link: 'https://a.io/b' })
    expect(rows[1]!.runs[0]).toMatchObject({ text: 'io/b', link: 'https://a.io/b' })
  })

  it('keeps a link the program set and returns rows without URLs untouched', () => {
    const plain = [row(0, [run('nothing here')])]
    expect(linkRows(plain, 20)[0]).toBe(plain[0])
    const osc = [row(0, [run('docs', { link: 'https://real' }), run(' https://shown')])]
    const linked = linkRows(osc, 30)[0]!
    expect(linked.runs[0]).toMatchObject({ text: 'docs', link: 'https://real' })
    expect(linked.runs.at(-1)).toMatchObject({ text: 'https://shown', link: 'https://shown' })
  })

  it('keeps wide characters’ widths when it splits a run', () => {
    const [linked] = linkRows([row(0, [{ ...run('日 https://a.io'), width: 15 }])], 20)
    expect(linked!.runs.map((piece) => piece.width)).toEqual([3, 12])
  })
})

describe('grid selection', () => {
  const lines = [
    row(10, [run('first line')]),
    row(11, [run('wrapped-row')], true),
    row(12, [run('tail')]),
    row(13, [run('foo(bar) baz')])
  ]
  const select = (
    anchor: [number, number],
    head: [number, number],
    unit: GridSelection['unit'] = 'cell'
  ): GridSelection => ({
    anchor: { line: anchor[0], col: anchor[1] },
    head: { line: head[0], col: head[1] },
    unit
  })

  it('reads text across lines beyond the screen, rejoining soft wraps', () => {
    expect(selectionText(select([10, 6], [12, 3]), lines, 11)).toBe('line\nwrapped-rowtail')
    // Backwards is the same selection.
    expect(selectionText(select([12, 3], [10, 6]), lines, 11)).toBe('line\nwrapped-rowtail')
  })

  it('selects words and lines', () => {
    expect(wordAt(lines[3]!, 5)).toEqual({ from: 4, to: 7 })
    expect(wordAt(lines[3]!, 3)).toEqual({ from: 3, to: 4 })
    expect(selectionText(select([13, 5], [13, 5], 'word'), lines, 12)).toBe('bar')
    expect(selectionText(select([10, 3], [10, 3], 'line'), lines, 11)).toBe('first line')
  })

  it('draws only the part on screen', () => {
    const selection = select([10, 6], [12, 3])
    expect(selectionSpans(selection, 11, 2, 11, lines.slice(1, 3))).toEqual([
      { row: 0, from: 0, to: 11 },
      { row: 1, from: 0, to: 4 }
    ])
    expect(isEmptySelection(select([1, 1], [1, 1]))).toBe(true)
    expect(isEmptySelection(select([1, 1], [1, 1], 'word'))).toBe(false)
  })
})
