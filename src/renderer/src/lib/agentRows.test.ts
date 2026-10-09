import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '@core/agentState.js'
import type { Task, TaskStatus, TerminalSessionInfo } from '@core/types.js'
import { agentRowsFor, boardSummary } from './agentRows.js'

const task = (id: string, overrides: Partial<Task> = {}): Task =>
  ({ id, title: id, status: 'in_progress', readiness: 'ready', ...overrides }) as Task
const status = (state: AgentStatus['state']): AgentStatus => ({ state }) as AgentStatus

const board = (tasks: Task[]): Record<TaskStatus, Task[]> => ({
  backlog: tasks.filter((t) => t.status === 'backlog'),
  in_progress: tasks.filter((t) => t.status === 'in_progress'),
  in_review: tasks.filter((t) => t.status === 'in_review'),
  done: tasks.filter((t) => t.status === 'done')
})

describe('agentRowsFor', () => {
  it('lists tasks with a status or a chat, dropping Done and archived ones', () => {
    const tasks = [
      task('A'),
      task('B', { agentSession: { provider: 'claude', id: 'x' } } as Partial<Task>),
      task('C'),
      task('D', { status: 'done' }),
      task('E', { archivedAt: '2026-01-01' })
    ]
    const shown = new Map([
      ['A', status('working')],
      ['D', status('idle')],
      ['E', status('waiting')]
    ])
    const rows = agentRowsFor(tasks, shown, [], 'default')
    expect(rows.map((row) => row.task.id)).toEqual(['A', 'B'])
  })

  it('puts agents with a status first, waiting ahead of working', () => {
    const tasks = [task('A'), task('B'), task('C', { agentSession: {} } as Partial<Task>)]
    const shown = new Map([
      ['A', status('working')],
      ['B', status('waiting')]
    ])
    expect(agentRowsFor(tasks, shown, [], 'default').map((row) => row.task.id)).toEqual([
      'B',
      'A',
      'C'
    ])
  })

  it('joins a task to its tab in this workspace only — ids repeat across workspaces', () => {
    const sessions = [
      { id: 'other', taskId: 'A', workspaceId: 'other' },
      { id: 'mine', taskId: 'A', workspaceId: 'default' }
    ] as TerminalSessionInfo[]
    const [row] = agentRowsFor([task('A')], new Map([['A', status('idle')]]), sessions, 'default')
    expect(row?.session?.id).toBe('mine')
  })
})

describe('boardSummary', () => {
  it('counts open tasks, those needing a spec and running agents', () => {
    const tasks = [
      task('A', { readiness: 'needs_spec', status: 'backlog' }),
      task('B'),
      task('C', { status: 'done' })
    ]
    const rows = agentRowsFor(tasks, new Map([['B', status('working')]]), [], 'default')
    expect(boardSummary(board(tasks), rows)).toBe('2 tasks · 1 needs a spec · 1 running')
  })

  it('leaves out the parts that are zero and pluralises', () => {
    expect(boardSummary(board([task('A', { status: 'backlog' })]), [])).toBe('1 task')
    const specs = [task('A', { readiness: 'needs_spec' }), task('B', { readiness: 'needs_spec' })]
    expect(boardSummary(board(specs), [])).toBe('2 tasks · 2 need a spec')
  })
})
