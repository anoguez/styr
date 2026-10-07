import { describe, expect, it } from 'vitest'
import type { AgentState, AgentStatus } from '@core/agentState.js'
import type { TerminalSessionInfo } from '@core/types.js'
import { dispatchingIds } from './dispatchRun.js'

const agent = (taskId: string, state: AgentState): [string, AgentStatus] => [
  taskId,
  { taskId, state, at: '' }
]
const session = (
  taskId: string,
  extra: Partial<TerminalSessionInfo> = {}
): TerminalSessionInfo => ({
  id: `s-${taskId}`,
  title: taskId,
  cwd: '/',
  taskId,
  workspaceId: 'w',
  ...extra
})

describe('dispatchingIds', () => {
  it('keeps tasks whose agent is still going and drops finished ones', () => {
    const agents = new Map([agent('A', 'working'), agent('B', 'idle'), agent('C', 'exited')])
    expect([...dispatchingIds(['A', 'B', 'C'], agents, [], 'w')]).toEqual(['A'])
  })

  it('keeps a task waiting on the user', () => {
    expect(dispatchingIds(['A'], new Map([agent('A', 'waiting')]), [], 'w').has('A')).toBe(true)
  })

  it('holds a task with no status yet only while its session is open', () => {
    expect(dispatchingIds(['A'], new Map(), [session('A')], 'w').has('A')).toBe(true)
    expect(dispatchingIds(['A'], new Map(), [], 'w').size).toBe(0)
  })

  it('ignores replays and sessions of another workspace', () => {
    const sessions = [session('A', { replay: true }), session('B', { workspaceId: 'other' })]
    expect(dispatchingIds(['A', 'B'], new Map(), sessions, 'w').size).toBe(0)
  })
})
