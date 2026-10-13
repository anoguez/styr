import type { EngineFrameLine } from '@core/types.js'
import { cellsText, rowCells } from './cells.js'

/**
 * The grid's own selection, in buffer coordinates (absolute line, column), so it reaches past the
 * visible screen: the view draws the part on screen, and copying reads the selected lines from the
 * engine's scrollback in the main process. Lines are numbered as the engine numbers them (0 is the
 * oldest line in the scrollback).
 */

export interface BufferPoint {
  line: number
  col: number
}

export interface GridSelection {
  anchor: BufferPoint
  head: BufferPoint
  /** Whole words or lines (double and triple click) extend by their unit. */
  unit: 'cell' | 'word' | 'line'
}

/** The selection's first and last cell, in reading order; `end` is inclusive. */
export function orderedRange(selection: GridSelection): { start: BufferPoint; end: BufferPoint } {
  const { anchor, head } = selection
  const forward = anchor.line < head.line || (anchor.line === head.line && anchor.col <= head.col)
  return forward ? { start: anchor, end: head } : { start: head, end: anchor }
}

/** True when nothing is selected beyond the cell the pointer went down on. */
export function isEmptySelection(selection: GridSelection): boolean {
  return (
    selection.unit === 'cell' &&
    selection.anchor.line === selection.head.line &&
    selection.anchor.col === selection.head.col
  )
}

/** The selected columns of each visible row, as `[from, to)`, for drawing the highlight. */
export function selectionSpans(
  selection: GridSelection,
  top: number,
  rows: number,
  cols: number,
  lines: EngineFrameLine[]
): { row: number; from: number; to: number }[] {
  const { start, end } = expanded(selection, (line) =>
    line >= top && line < top + rows ? lines[line - top] : undefined
  )
  const spans: { row: number; from: number; to: number }[] = []
  for (let line = Math.max(start.line, top); line <= Math.min(end.line, top + rows - 1); line++) {
    const from = line === start.line ? start.col : 0
    const to = Math.min(line === end.line ? end.col + 1 : cols, cols)
    if (to > from) spans.push({ row: line - top, from, to })
  }
  return spans
}

/** The range after word or line units are applied, with rows read through `rowAt` when needed. */
export function expanded(
  selection: GridSelection,
  rowAt: (line: number) => EngineFrameLine | undefined
): { start: BufferPoint; end: BufferPoint } {
  const { start, end } = orderedRange(selection)
  if (selection.unit === 'line') {
    return { start: { line: start.line, col: 0 }, end: { line: end.line, col: Infinity } }
  }
  if (selection.unit === 'word') {
    const first = rowAt(start.line)
    const last = rowAt(end.line)
    return {
      start: { line: start.line, col: first ? wordAt(first, start.col).from : start.col },
      end: { line: end.line, col: last ? wordAt(last, end.col).to - 1 : end.col }
    }
  }
  return { start, end }
}

// What ends a word, as xterm's default `wordSeparator` has it.
const SEPARATORS = new Set([' ', '(', ')', '[', ']', '{', '}', "'", '"', '`', ',', ';', '\t', ''])

/** The word under column `col`, as `[from, to)`; a separator is a word of its own. */
export function wordAt(line: EngineFrameLine, col: number): { from: number; to: number } {
  const cells = rowCells(line)
  const isWord = (index: number): boolean => {
    const cell = cells[index]
    // The second half of a wide character belongs to the character.
    if (cell && cell.text === '' && index > 0) return isWord(index - 1)
    return cell !== undefined && !SEPARATORS.has(cell.text)
  }
  if (!isWord(col)) return { from: col, to: col + 1 }
  let from = col
  let to = col + 1
  while (from > 0 && isWord(from - 1)) from--
  while (to < cells.length && isWord(to)) to++
  return { from, to }
}

/**
 * The selected text from rows `lines` (each `row` an absolute line, as `styledLines` returns them):
 * a soft-wrapped row runs on into the next without a newline, and trailing blanks are dropped.
 */
export function selectionText(
  selection: GridSelection,
  lines: EngineFrameLine[],
  cols: number
): string {
  const byLine = new Map(lines.map((line) => [line.row, line]))
  const { start, end } = expanded(selection, (line) => byLine.get(line))
  let text = ''
  for (let line = start.line; line <= end.line; line++) {
    const row = byLine.get(line)
    const cells = row ? rowCells(row) : []
    const from = line === start.line ? start.col : 0
    const to = Math.min(line === end.line ? end.col + 1 : cols, cols)
    const piece = cellsText(cells, from, Math.max(from, to))
    if (line === end.line) text += piece.trimEnd()
    else if (row?.wrapped && to >= cols) text += piece
    else text += `${piece.trimEnd()}\n`
  }
  return text
}
