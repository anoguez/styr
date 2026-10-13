import type { EngineFrameLine, EngineRun } from '@core/types.js'
import { rowCells, type Cell } from './cells.js'

/**
 * Links in native terminal output: plain `http(s)` URLs found in the text, and OSC 8 hyperlinks the
 * engine reports on runs (`EngineRun.link`, package 0.4.0). Output is untrusted, so nothing here
 * opens anything: a view opens a link only on an explicit click, through `terminal:openLink`, which
 * takes web links alone.
 */

/** Whether a link may be opened: web links only, as `terminal:openLink` enforces. */
export function isOpenableLink(link: string | undefined): link is string {
  return link !== undefined && /^https?:\/\/[^\s]+$/i.test(link)
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`\\]+/gi
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/** The web URLs in `text`, as string offsets; trailing punctuation and unmatched closers are left out. */
export function findUrls(text: string): { start: number; end: number; url: string }[] {
  const found: { start: number; end: number; url: string }[] = []
  for (const match of text.matchAll(URL_PATTERN)) {
    let url = match[0]
    for (;;) {
      const last = url.at(-1) ?? ''
      if ('.,;:!?'.includes(last)) url = url.slice(0, -1)
      else if (CLOSERS[last] && count(url, CLOSERS[last]) < count(url, last)) url = url.slice(0, -1)
      else break
    }
    // Nothing after the scheme is not a link.
    if (/^https?:\/\/$/i.test(url)) continue
    found.push({ start: match.index, end: match.index + url.length, url })
  }
  return found
}

function count(text: string, char: string): number {
  let total = 0
  for (const each of text) if (each === char) total++
  return total
}

/**
 * Rows with their links on runs: each run is split where a URL found in its text starts or ends,
 * and the URL's pieces carry it as `link` (an OSC 8 link the program set is kept). A URL that
 * wraps onto the next row is found across the wrap. Rows without a URL are returned as they were.
 */
export function linkRows(rows: EngineFrameLine[], cols: number): EngineFrameLine[] {
  const result: EngineFrameLine[] = []
  let group: EngineFrameLine[] = []
  const flush = (): void => {
    if (group.length === 1) result.push(linkRow(group[0]!, cols))
    else if (group.length > 0) result.push(...linkGroup(group, cols))
    group = []
  }
  for (const row of rows) {
    group.push(row)
    if (!row.wrapped) flush()
  }
  flush()
  return result
}

// Rows are immutable once received, and a block list redraws its history on every frame.
const linkedRows = new WeakMap<EngineFrameLine, EngineFrameLine>()

function linkRow(row: EngineFrameLine, cols: number): EngineFrameLine {
  const cached = linkedRows.get(row)
  if (cached) return cached
  const linked = linkGroup([row], cols)[0]!
  linkedRows.set(row, linked)
  return linked
}

/** One logical line: rows joined across soft wraps. */
function linkGroup(rows: EngineFrameLine[], cols: number): EngineFrameLine[] {
  const cells = rows.map(rowCells)
  // The text the reader sees, with the blanks the engine dropped before a wrap put back.
  let text = ''
  const owners: { row: number; col: number }[] = []
  cells.forEach((rowCellList, row) => {
    rowCellList.forEach((cell, col) => {
      for (let index = 0; index < cell.text.length; index++) owners.push({ row, col })
      text += cell.text
    })
    if (rows[row]!.wrapped) {
      for (let col = rowCellList.length; col < cols; col++) {
        owners.push({ row, col: -1 })
        text += ' '
      }
    }
  })
  const urls = findUrls(text)
  if (urls.length === 0) return rows

  const linked = cells.map((rowCellList) => rowCellList.map((cell) => ({ ...cell })))
  for (const { start, end, url } of urls) {
    for (let offset = start; offset < end; offset++) {
      const owner = owners[offset]!
      const cell = owner.col >= 0 ? linked[owner.row]![owner.col] : undefined
      // A link the program set wins over one found in its text.
      if (cell && !cell.link) cell.link = url
    }
  }
  return rows.map((row, index) => ({ ...row, runs: regroup(row.runs, linked[index]!) }))
}

/** Runs rebuilt from cells, split wherever the run or the link changes. */
function regroup(runs: EngineRun[], cells: Cell[]): EngineRun[] {
  const out: EngineRun[] = []
  let current: (EngineRun & { source: number }) | null = null
  for (const cell of cells) {
    if (!current || current.source !== cell.run || current.link !== cell.link) {
      if (current) out.push(strip(current))
      const { text: _text, width: _width, link: _link, ...style } = runs[cell.run]!
      current = { ...style, text: '', width: 0, source: cell.run }
      if (cell.link) current.link = cell.link
    }
    current.text += cell.text
    current.width += 1
  }
  if (current) out.push(strip(current))
  return out
}

function strip(run: EngineRun & { source: number }): EngineRun {
  const { source: _source, ...rest } = run
  return rest
}
