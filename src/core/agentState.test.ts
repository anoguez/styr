import { describe, expect, it } from 'vitest'
import { shownAgentState, shownAgents, type AgentStatus } from './agentState.js'

const inReview = { status: 'in_review', orchestrate: false, readiness: 'ready' } as const

describe('shownAgentState', () => {
  it('shows an idle agent on an In Review task outside Dispatch as waiting on you', () => {
    expect(shownAgentState('idle', inReview)).toBe('waiting')
  })

  it('keeps a dispatched In Review task idle, since Dispatch moves it on', () => {
    expect(shownAgentState('idle', { ...inReview, orchestrate: true })).toBe('idle')
  })

  it('leaves every other status and state alone', () => {
    expect(shownAgentState('idle', { ...inReview, status: 'in_progress' })).toBe('idle')
    expect(shownAgentState('working', inReview)).toBe('working')
    expect(shownAgentState('exited', inReview)).toBe('exited')
    expect(shownAgentState('idle', { ...inReview, readiness: 'needs_spec' })).toBe('idle')
  })
})

describe('shownAgents', () => {
  it('relabels only the agents whose task calls for it', () => {
    const idle: AgentStatus = { taskId: 'TASK-0001', state: 'idle', at: '2026-01-01T00:00:00Z' }
    const orphan: AgentStatus = { ...idle, taskId: 'TASK-0009' }
    const agents = new Map([
      [idle.taskId, idle],
      [orphan.taskId, orphan]
    ])
    const shown = shownAgents(agents, [{ id: 'TASK-0001', ...inReview }])
    expect(shown.get('TASK-0001')?.state).toBe('waiting')
    expect(shown.get('TASK-0009')).toBe(orphan)
    expect(idle.state).toBe('idle')
  })
})
