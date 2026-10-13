import type { EngineFrameLine, EngineRun } from '@core/types.js'

/**
 * Runs as cells. A run holds its text and how many cells it covers, but not which character sits in
 * which cell; selection and links work in cells (the grid's columns), so they split runs here.
 */

// East Asian wide and fullwidth blocks and emoji: the characters a terminal gives two cells.
const WIDE =
  /\p{Extended_Pictographic}|[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * The text in each cell `run` covers: `''` for the second half of a wide character. When the guess
 * at widths disagrees with the engine's (a font's emoji, say), cells are filled one character each
 * and the rest left empty, so the count always matches `run.width`.
 */
export function runCells(run: EngineRun): string[] {
  const parts = Array.from(graphemes.segment(run.text), (part) => part.segment)
  if (parts.length === run.width) return parts
  const cells: string[] = []
  for (const part of parts) {
    cells.push(part)
    if (WIDE.test(part)) cells.push('')
  }
  if (cells.length === run.width) return cells
  const fitted = parts.slice(0, run.width)
  while (fitted.length < run.width) fitted.push('')
  return fitted
}

export interface Cell {
  text: string
  /** Index of the run in its row the cell came from. */
  run: number
  link?: string
}

/** A row's cells, left to right; cells after its last run (trailing blanks) are not included. */
export function rowCells(line: EngineFrameLine): Cell[] {
  const cells: Cell[] = []
  line.runs.forEach((run, index) => {
    for (const text of runCells(run)) {
      cells.push(run.link ? { text, run: index, link: run.link } : { text, run: index })
    }
  })
  return cells
}

/** The text of cells `from` to `to` (exclusive) of a row, blanks past its last run as spaces. */
export function cellsText(cells: Cell[], from: number, to: number): string {
  let text = ''
  for (let col = from; col < to; col++) text += col < cells.length ? cells[col]!.text : ' '
  return text
}
