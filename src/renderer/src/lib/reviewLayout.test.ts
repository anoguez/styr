import { describe, expect, it } from 'vitest'
import { buildRows } from '@core/diffView.js'
import type { ReviewComment, TaskReview } from '@core/types.js'
import { pendingByPath, reviewLayout } from './reviewLayout.js'

const rows = buildRows(['@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three'].join('\n'))
const at = (text: string): number =>
  rows.findIndex((row) => 'segments' in row && row.segments[0]?.text === text)

function comment(extra: Partial<ReviewComment>): ReviewComment {
  return {
    id: 'c1',
    path: 'a.ts',
    side: 'new',
    line: 2,
    text: 'TWO',
    body: 'b',
    createdAt: '2026-10-22T10:00:00.000Z',
    ...extra
  }
}

describe('reviewLayout', () => {
  it('draws pending comments under their rows and lists the outdated ones', () => {
    const review: TaskReview = {
      taskId: 'TASK-1',
      pending: [
        comment({ id: 'b', createdAt: '2026-10-22T11:00:00.000Z' }),
        comment({ id: 'a' }),
        comment({ id: 'gone', text: 'nope' }),
        comment({ id: 'other', path: 'b.ts' })
      ]
    }
    const layout = reviewLayout(rows, 'a.ts', review, null)
    expect(layout.threads.get(at('TWO'))!.map((item) => item.comment.id)).toEqual(['a', 'b'])
    expect(layout.outdated.map((c) => c.id)).toEqual(['gone'])
    expect(pendingByPath(review)).toEqual(
      new Map([
        ['a.ts', 3],
        ['b.ts', 1]
      ])
    )
  })

  it('draws the last sent batch only on its exact line, and a comment being edited as the composer', () => {
    const review: TaskReview = {
      taskId: 'TASK-1',
      pending: [comment({ id: 'edit' })],
      lastSent: {
        at: '2026-10-22T09:00:00.000Z',
        comments: [
          comment({ id: 'here', side: 'old', text: 'two' }),
          comment({ id: 'moved', line: 9, text: 'three' })
        ]
      }
    }
    const layout = reviewLayout(rows, 'a.ts', review, {
      anchor: { path: 'a.ts', side: 'new', line: 2, text: 'TWO' },
      editId: 'edit'
    })
    expect([...layout.threads.values()].flat().map((item) => [item.comment.id, item.sent])).toEqual(
      [['here', true]]
    )
    expect(layout.draftRow).toBe(at('TWO'))
  })

  it('puts a draft whose line is gone at the top', () => {
    const layout = reviewLayout(
      rows,
      'a.ts',
      { taskId: 'TASK-1', pending: [] },
      {
        anchor: { path: 'a.ts', side: 'new', line: 2, text: 'removed' }
      }
    )
    expect(layout.draftRow).toBe('top')
  })
})
