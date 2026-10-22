import { describe, expect, it } from 'vitest'
import type { ReviewComment, ReviewSent } from '@core/types.js'
import { closingNote } from './RequestChangesSheet.js'
import { orderedComments } from './ReviewCommentList.js'
import { sentToastText } from './ReviewSentToast.js'

function comment(id: string, path: string, line: number): ReviewComment {
  return { id, path, side: 'new', line, text: '', body: id, createdAt: '2026-10-22T10:00:00.000Z' }
}

describe('sentToastText', () => {
  const sent = (extra: Partial<ReviewSent>): ReviewSent => ({
    route: 'resume',
    provider: 'claude',
    count: 3,
    files: 2,
    movedToInProgress: true,
    ...extra
  })

  it('says a resumed session took the comments, and that the task moved', () => {
    expect(sentToastText(sent({}), 'TASK-0015')).toEqual({
      title: 'Sent 3 comments to Claude',
      body: 'Its session resumed in a terminal tab, now focused. TASK-0015 is back in In Progress.'
    })
  })

  it('says a running agent has them queued, and leaves out a move that did not happen', () => {
    expect(
      sentToastText(
        sent({ route: 'queued', provider: 'codex', count: 1, movedToInProgress: false }),
        'TASK-1'
      )
    ).toEqual({
      title: 'Queued 1 comment for Codex',
      body: 'Delivered the next time it waits for input.'
    })
  })
})

describe('orderedComments', () => {
  it('lists pending by path and line, then the sent batch', () => {
    const order = orderedComments({
      taskId: 'TASK-1',
      pending: [comment('b2', 'b.ts', 2), comment('a9', 'a.ts', 9), comment('a1', 'a.ts', 1)],
      lastSent: { at: '2026-10-22T09:00:00.000Z', comments: [comment('s', 'a.ts', 3)] }
    })
    expect(order.map((item) => [item.comment.id, item.sent])).toEqual([
      ['a1', false],
      ['a9', false],
      ['b2', false],
      ['s', true]
    ])
  })
})

describe('closingNote', () => {
  it('moves In Review and Done back, and Backlog only when the agent is launched', () => {
    const at = (status: 'backlog' | 'in_progress' | 'in_review' | 'done') => ({
      id: 'TASK-7',
      status
    })
    expect(closingNote(at('in_review'), 'now')).toBe(
      'Closes this dialog and moves TASK-7 back to In Progress.'
    )
    expect(closingNote(at('done'))).toBe('Closes this dialog and moves TASK-7 back to In Progress.')
    expect(closingNote(at('backlog'), 'fresh')).toBe(
      'Closes this dialog and moves TASK-7 to In Progress.'
    )
    expect(closingNote(at('backlog'), 'now')).toBe('Closes this dialog.')
    expect(closingNote(at('in_progress'), 'resume')).toBe('Closes this dialog.')
  })
})
