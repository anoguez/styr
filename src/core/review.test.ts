import { describe, expect, it } from 'vitest'
import { buildRows, type DiffRow } from './diffView.js'
import {
  commentAnchor,
  commentRef,
  groupComments,
  placeComments,
  reviewMessage,
  REANCHOR_LINES
} from './review.js'
import type { ReviewComment } from './types.js'

const PATCH = [
  '@@ -1,4 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  ' four',
  '@@ -20,2 +20,3 @@ fn',
  ' twenty',
  '+new',
  ' twenty-one'
].join('\n')

function comment(extra: Partial<ReviewComment>): ReviewComment {
  return {
    id: 'c1',
    path: 'src/a.ts',
    side: 'new',
    line: 1,
    text: 'one',
    body: 'Fix it',
    createdAt: '2026-10-22T10:00:00.000Z',
    ...extra
  }
}

describe('commentAnchor', () => {
  const rows = buildRows(PATCH)

  it('points added and context rows at the new side, deleted rows at the old side', () => {
    const at = (text: string): DiffRow =>
      rows.find((row) => 'segments' in row && row.segments.map((s) => s.text).join('') === text)!
    expect(commentAnchor(at('one'), 'src/a.ts')).toEqual({
      path: 'src/a.ts',
      side: 'new',
      line: 1,
      text: 'one'
    })
    expect(commentAnchor(at('two'), 'src/a.ts')).toMatchObject({ side: 'old', line: 2 })
    expect(commentAnchor(at('TWO'), 'src/a.ts')).toMatchObject({ side: 'new', line: 2 })
    expect(commentAnchor(at('new'), 'src/a.ts')).toMatchObject({ side: 'new', line: 21 })
  })

  it('has no anchor for hunk and fold rows', () => {
    expect(
      commentAnchor(
        rows.find((row) => row.kind === 'hunk')!,
        'a'
      )
    ).toBeNull()
    expect(
      commentAnchor(
        rows.find((row) => row.kind === 'fold')!,
        'a'
      )
    ).toBeNull()
  })

  it('names the line', () => {
    expect(commentRef({ side: 'new', line: 42 })).toBe('Line 42')
    expect(commentRef({ side: 'old', line: 42 })).toBe('Old line 42')
  })
})

describe('placeComments', () => {
  const rows = buildRows(PATCH)
  const rowOf = (text: string): number =>
    rows.findIndex((row) => 'segments' in row && row.segments.map((s) => s.text).join('') === text)

  it('places on the same side and line with the same text', () => {
    const placed = placeComments(rows, [
      comment({ id: 'a' }),
      comment({ id: 'b', side: 'old', line: 2, text: 'two' })
    ])
    expect(placed.get('a')).toEqual({ row: rowOf('one'), folded: false })
    expect(placed.get('b')).toEqual({ row: rowOf('two'), folded: false })
  })

  it('moves to the nearest row with the same text when the line shifted', () => {
    const placed = placeComments(rows, [comment({ line: 30, text: 'twenty-one' })])
    expect(placed.get('c1')).toEqual({ row: rowOf('twenty-one'), folded: false })
  })

  it('is outdated past the re-anchoring distance, or when the text is gone', () => {
    const far = 22 + REANCHOR_LINES + 1
    const placed = placeComments(rows, [
      comment({ id: 'far', line: far, text: 'twenty-one' }),
      comment({ id: 'gone', line: 3, text: 'not there' })
    ])
    expect(placed.get('far')).toBe('outdated')
    expect(placed.get('gone')).toBe('outdated')
  })

  it('never matches the other side', () => {
    const placed = placeComments(rows, [comment({ side: 'old', line: 2, text: 'TWO' })])
    expect(placed.get('c1')).toBe('outdated')
  })

  it('lands in the fold that hides its line', () => {
    const fold = rows.findIndex((row) => row.kind === 'fold')
    const placed = placeComments(rows, [comment({ line: 10, text: 'ten' })])
    expect(placed.get('c1')).toEqual({ row: fold, folded: true })
  })
})

describe('reviewMessage', () => {
  const comments = [
    comment({ id: 'b', path: 'src/z.ts', line: 9, text: '  return x  ', body: 'Rename x' }),
    comment({ id: 'a', path: 'src/a.ts', line: 12, text: 'const a = 1', body: 'Two\nlines' }),
    comment({ id: 'c', path: 'src/a.ts', side: 'old', line: 3, text: 'gone()', body: 'Why?' })
  ]

  it('lists each comment as path:line with its text and body, grouped by file', () => {
    const message = reviewMessage(
      { kind: 'branch', branch: 'styr/TASK-1', base: 'main' },
      comments,
      '  Overall: tidy up.  ',
      new Set(['b'])
    )
    expect(message).toBe(
      [
        'Review of styr/TASK-1 against main: 3 comments in 2 files. Address each one, then reply with what you changed.',
        '',
        'Overall: tidy up.',
        '',
        'src/a.ts',
        '- src/a.ts:3 (old side)  gone()',
        '  Why?',
        '- src/a.ts:12  const a = 1',
        '  Two',
        '  lines',
        '',
        'src/z.ts',
        '- src/z.ts:9 (outdated)  return x',
        '  Rename x'
      ].join('\n')
    )
  })

  it('names the working tree for a task without a worktree, and skips an empty note', () => {
    const message = reviewMessage({ kind: 'repo', repoName: 'styr' }, [comments[0]!], ' ')
    expect(message.split('\n').slice(0, 3)).toEqual([
      'Review of the working tree changes in styr: 1 comment in 1 file. Address each one, then reply with what you changed.',
      '',
      'src/z.ts'
    ])
  })

  it('groups by path, then line', () => {
    expect(groupComments(comments).map((g) => [g.path, g.comments.map((c) => c.id)])).toEqual([
      ['src/a.ts', ['c', 'a']],
      ['src/z.ts', ['b']]
    ])
  })
})
