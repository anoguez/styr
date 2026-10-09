import { describe, expect, it } from 'vitest'
import {
  runningSubagents,
  shownAgentState,
  shownAgents,
  subagentCountLabel,
  visibleSubagents,
  type AgentStatus,
  type SubagentStatus
} from './agentState.js'

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

describe('subagent display', () => {
  const sub = (id: string, state: SubagentStatus['state'] = 'running'): SubagentStatus => ({
    id,
    label: id,
    state,
    startedAt: '2026-01-01T00:00:00Z'
  })

  it('shows up to four rows in full', () => {
    const four = [sub('a', 'done'), sub('b'), sub('c'), sub('d')]
    expect(visibleSubagents(four, false)).toEqual({ rows: four })
  })

  it('folds five or more to the three oldest and says how many hidden ones run', () => {
    const ten = [sub('a', 'done'), ...'bcdefghij'.split('').map((id) => sub(id))]
    const folded = visibleSubagents(ten, false)
    expect(folded.rows.map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(folded.toggle).toBe('+7 more · 7 running')
    expect(visibleSubagents(ten, true)).toEqual({ rows: ten, toggle: 'Show fewer' })
    const allDone = ten.map((row) => ({ ...row, state: 'done' as const }))
    expect(visibleSubagents(allDone, false).toggle).toBe('+7 more')
  })

  it('counts only running subagents, with a plural label', () => {
    expect(runningSubagents(undefined)).toBe(0)
    expect(runningSubagents({ subagents: [sub('a'), sub('b', 'done'), sub('c')] })).toBe(2)
    expect(subagentCountLabel(1)).toBe('1 subagent')
    expect(subagentCountLabel(3)).toBe('3 subagents')
  })
})
