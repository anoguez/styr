/**
 * Review comments on a diff, pure: where a comment points (`commentAnchor`), where it lands on a
 * refreshed diff (`placeComments`) and the message Request changes sends (`reviewMessage`). The
 * renderer and the host both use it, so it imports nothing from node.
 */
import type { DiffRow } from './diffView.js'
import type { ReviewComment, ReviewSide, ReviewTarget } from './types.js'

/** A stored line text is cut here: enough to re-anchor and to show, never a minified file. */
export const ANCHOR_TEXT_CHARS = 2000

/** How far a comment may move to a line with its text, after the agent's edits. */
export const REANCHOR_LINES = 50

export interface CommentAnchor {
  path: string
  side: ReviewSide
  line: number
  text: string
}

type LineRow = Extract<DiffRow, { kind: 'ctx' | 'add' | 'del' }>

const isLine = (row: DiffRow): row is LineRow =>
  row.kind === 'ctx' || row.kind === 'add' || row.kind === 'del'

const rowText = (row: LineRow): string => row.segments.map((segment) => segment.text).join('')

/** Where a comment on `row` points; null for hunk and fold rows. */
export function commentAnchor(row: DiffRow, path: string): CommentAnchor | null {
  if (!isLine(row)) return null
  const side: ReviewSide = row.kind === 'del' ? 'old' : 'new'
  const line = side === 'old' ? row.oldLine : row.newLine
  if (line === undefined) return null
  return { path, side, line, text: rowText(row).slice(0, ANCHOR_TEXT_CHARS) }
}

/** "Line 42", or "Old line 42" for a deleted row. */
export function commentRef(anchor: Pick<CommentAnchor, 'side' | 'line'>): string {
  return `${anchor.side === 'old' ? 'Old line' : 'Line'} ${anchor.line}`
}

/** Where one comment is drawn: on a row, inside a fold row, or nowhere (outdated). */
export type Placement = { row: number; folded: boolean } | 'outdated'

/**
 * The line range each fold hides, per side. A fold sits between two hunks and hides unchanged
 * lines, so on both sides it starts after the last line drawn above it and spans `count` lines.
 */
function foldRanges(rows: DiffRow[]): Map<number, Record<ReviewSide, [number, number]>> {
  const ranges = new Map<number, Record<ReviewSide, [number, number]>>()
  rows.forEach((row, index) => {
    if (row.kind !== 'fold') return
    const span = (side: ReviewSide): [number, number] => {
      const from = (lastOf(rows, index, side) ?? 0) + 1
      return [from, from + row.count - 1]
    }
    ranges.set(index, { old: span('old'), new: span('new') })
  })
  return ranges
}

/** The last line number on `side` before `index`. */
function lastOf(rows: DiffRow[], index: number, side: ReviewSide): number | undefined {
  for (let at = index - 1; at >= 0; at--) {
    const row = rows[at]!
    if (!isLine(row)) continue
    const line = side === 'old' ? row.oldLine : row.newLine
    if (line !== undefined) return line
  }
  return undefined
}

/**
 * Where each comment lands on `rows` (one file's diff), by id: the row on the same side and line
 * with the same text; else a fold that hides that line; else the nearest row on that side with the
 * same text within `REANCHOR_LINES`; else outdated.
 */
export function placeComments(
  rows: DiffRow[],
  comments: readonly ReviewComment[]
): Map<string, Placement> {
  const bySide: Record<ReviewSide, { line: number; text: string; row: number }[]> = {
    old: [],
    new: []
  }
  rows.forEach((row, index) => {
    const anchor = commentAnchor(row, '')
    if (anchor) bySide[anchor.side].push({ line: anchor.line, text: anchor.text, row: index })
  })
  const folds = foldRanges(rows)
  const placed = new Map<string, Placement>()
  for (const comment of comments) {
    const candidates = bySide[comment.side]
    const exact = candidates.find((c) => c.line === comment.line && c.text === comment.text)
    if (exact) {
      placed.set(comment.id, { row: exact.row, folded: false })
      continue
    }
    const fold = [...folds].find(([, range]) => {
      const [from, to] = range[comment.side]
      return comment.line >= from && comment.line <= to
    })
    if (fold) {
      placed.set(comment.id, { row: fold[0], folded: true })
      continue
    }
    let best: { row: number; distance: number } | undefined
    for (const candidate of candidates) {
      if (candidate.text !== comment.text) continue
      const distance = Math.abs(candidate.line - comment.line)
      if (distance <= REANCHOR_LINES && (!best || distance < best.distance)) {
        best = { row: candidate.row, distance }
      }
    }
    placed.set(comment.id, best ? { row: best.row, folded: false } : 'outdated')
  }
  return placed
}

export const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`

/** Comments in the order the sheet and the message list them: by path, then line. */
export function sortComments<T extends ReviewComment>(comments: readonly T[]): T[] {
  return [...comments].sort(
    (a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      a.line - b.line ||
      a.createdAt.localeCompare(b.createdAt)
  )
}

/** Pending comments grouped by file, in message order. */
export function groupComments<T extends ReviewComment>(
  comments: readonly T[]
): { path: string; comments: T[] }[] {
  const groups: { path: string; comments: T[] }[] = []
  for (const comment of sortComments(comments)) {
    const last = groups[groups.length - 1]
    if (last?.path === comment.path) last.comments.push(comment)
    else groups.push({ path: comment.path, comments: [comment] })
  }
  return groups
}

/**
 * The one message Request changes sends the agent, which the sheet's preview shows verbatim.
 * `outdated` holds the ids of comments that no longer place on the diff.
 */
export function reviewMessage(
  target: ReviewTarget,
  comments: readonly ReviewComment[],
  summary: string,
  outdated: ReadonlySet<string> = new Set()
): string {
  const groups = groupComments(comments)
  const counts = `${plural(comments.length, 'comment')} in ${plural(groups.length, 'file')}`
  const subject =
    target.kind === 'branch'
      ? `Review of ${target.branch} against ${target.base}`
      : `Review of the working tree changes in ${target.repoName}`
  const lines = [`${subject}: ${counts}. Address each one, then reply with what you changed.`]
  const note = summary.trim()
  if (note) lines.push('', note)
  for (const group of groups) {
    lines.push('', group.path)
    for (const comment of group.comments) {
      const marks = `${comment.side === 'old' ? ' (old side)' : ''}${outdated.has(comment.id) ? ' (outdated: the line has changed)' : ''}`
      const text = comment.text.trim()
      lines.push(`- ${comment.path}:${comment.line}${marks}${text ? `  ${text}` : ''}`)
      for (const bodyLine of comment.body.trim().split(/\r?\n/)) lines.push(`  ${bodyLine}`)
    }
  }
  return lines.join('\n')
}
