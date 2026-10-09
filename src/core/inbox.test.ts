import { describe, expect, it } from 'vitest'
import type { AgentState, AgentStatus } from './agentState.js'
import { buildInbox, summariseInbox } from './inbox.js'
import type { Task } from './types.js'

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    status: 'backlog',
    readiness: 'ready',
    blockedBy: [],
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra
  } as unknown as Task
}
function agent(taskId: string, state: AgentState, at = '2026-01-02T00:00:00Z'): AgentStatus {
  return { taskId, state, at }
}
const ids = (items: { task: Task }[]): string[] => items.map((i) => i.task.id)

describe('buildInbox', () => {
  it('puts waiting agents, specs and finished reviews under Needs you', () => {
    const inbox = buildInbox(
      [
        task('A', { status: 'in_progress' }),
        task('B', { readiness: 'needs_spec' }),
        task('C', { status: 'in_review' })
      ],
      new Map([
        ['A', agent('A', 'waiting')],
        ['C', agent('C', 'idle')]
      ])
    )
    expect(inbox.needs[0]?.kind).toBe('waiting')
    expect(inbox.needs.map((i) => i.kind).sort()).toEqual(['review', 'spec', 'waiting'])
  })

  it('lets a working agent outrank needs_spec', () => {
    const inbox = buildInbox(
      [task('A', { readiness: 'needs_spec', status: 'in_progress' })],
      new Map([['A', agent('A', 'working')]])
    )
    expect(ids(inbox.running)).toEqual(['A'])
    expect(inbox.needs).toEqual([])
  })

  it('orders Up next as queued, finished, resumable, then unassigned reasons', () => {
    const inbox = buildInbox(
      [task('Q'), task('R', { agentSession: { provider: 'claude', id: 'x' } }), task('N')],
      new Map(),
      new Map([['Q', 1]])
    )
    expect(inbox.next.map((i) => i.kind).sort()).toEqual(['idle', 'queued', 'resumable'])
    expect(inbox.next.find((i) => i.task.id === 'Q')?.reason).toBe('Queued #1 for Dispatch')
  })

  it('puts a blocked task in Up next after the others, and frees it once the blocker is Done', () => {
    const blocked = task('B', { blockedBy: ['A'] })
    const free = task('F')
    const held = buildInbox([task('A', { status: 'in_progress' }), blocked, free], new Map())
    expect(ids(held.next)).toEqual(['A', 'F', 'B'])
    const item = held.next.find((i) => i.task.id === 'B')
    expect(item).toMatchObject({ kind: 'blocked', blockers: ['A'], reason: 'Blocked by A' })

    const freed = buildInbox([task('A', { status: 'done' }), blocked], new Map())
    expect(freed.next.map((i) => i.kind)).toEqual(['idle'])
  })

  it('looks blockers up in the full list when the board shows fewer tasks', () => {
    const blocked = task('B', { blockedBy: ['A'] })
    const inbox = buildInbox([blocked], new Map(), new Map(), [
      task('A', { status: 'in_progress' }),
      blocked
    ])
    expect(inbox.next[0]?.kind).toBe('blocked')
  })

  it('still asks for a spec on a blocked task that has none', () => {
    const inbox = buildInbox(
      [
        task('A', { status: 'in_progress' }),
        task('B', { blockedBy: ['A'], readiness: 'needs_spec' })
      ],
      new Map()
    )
    expect(inbox.needs.map((i) => i.kind)).toEqual(['spec'])
  })

  it('lists done tasks but drops archived ones', () => {
    const inbox = buildInbox(
      [
        task('D', { status: 'done' }),
        task('E', { status: 'done', archivedAt: '2026-01-03T00:00:00Z' })
      ],
      new Map()
    )
    expect(ids(inbox.done)).toEqual(['D'])
  })
})

describe('summariseInbox', () => {
  it('counts each group and splits Needs you by kind', () => {
    const summary = summariseInbox(
      buildInbox(
        [
          task('A', { status: 'in_progress' }),
          task('B', { readiness: 'needs_spec' }),
          task('C', { status: 'in_review' }),
          task('D', { status: 'in_progress' }),
          task('E'),
          task('F', { status: 'done' })
        ],
        new Map([
          ['A', agent('A', 'waiting')],
          ['C', agent('C', 'idle')],
          ['D', agent('D', 'working')]
        ])
      )
    )
    expect(summary).toEqual({ needs: 3, running: 1, next: 1, waiting: 1, review: 1, spec: 1 })
  })

  it('is all zeroes for an empty board', () => {
    expect(summariseInbox(buildInbox([], new Map()))).toEqual({
      needs: 0,
      running: 0,
      next: 0,
      waiting: 0,
      review: 0,
      spec: 0
    })
  })
})
