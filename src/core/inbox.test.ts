import { describe, expect, it } from 'vitest'
import type { AgentState, AgentStatus } from './agentState.js'
import { buildInbox } from './inbox.js'
import type { Task } from './types.js'

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    status: 'backlog',
    readiness: 'ready',
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
    expect(inbox.next.find((i) => i.task.id === 'Q')?.reason).toBe('Queued #1 for Orchestrate')
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
