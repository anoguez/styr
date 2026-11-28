import { describe, expect, it } from 'vitest'
import type { AgentMessageBlock, AgentToolCallBlock, BlockState } from '@core/types/blocks.js'
import { groupToolCalls, summarizeToolGroup, type ToolGroup } from './toolGroups.js'

const message = (id: string, role: 'user' | 'assistant'): AgentMessageBlock =>
  ({
    id,
    kind: 'agent-message',
    sessionId: 's',
    state: 'completed',
    payload: { role, text: id }
  }) as AgentMessageBlock

const call = (id: string, tool = 'Bash', state: BlockState = 'completed'): AgentToolCallBlock => ({
  id,
  kind: 'agent-tool-call',
  sessionId: 's',
  createdAt: 0,
  updatedAt: 0,
  state,
  payload: { tool, summary: `${tool} ${id}\nsecond line` }
})

describe('groupToolCalls', () => {
  it('folds a run of calls into one group, and leaves a lone call as it is', () => {
    const items = groupToolCalls([
      message('ask', 'user'),
      call('a'),
      call('b'),
      call('c'),
      message('said', 'assistant'),
      call('d')
    ])
    expect(items.map((item) => item.row.kind)).toEqual([
      'agent-message',
      'tool-group',
      'agent-message',
      'agent-tool-call'
    ])
    const group = items[1]!.row as ToolGroup
    expect(group.id).toBe('a')
    expect(group.calls.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('puts the avatar on the first row of each of the agent’s turns', () => {
    const items = groupToolCalls([
      message('ask', 'user'),
      call('a'),
      call('b'),
      message('said', 'assistant'),
      message('again', 'user'),
      message('reply', 'assistant')
    ])
    expect(items.map((item) => item.avatar)).toEqual([false, true, false, false, true])
    expect(groupToolCalls([call('a'), call('b')])[0]!.avatar).toBe(true)
  })
})

describe('summarizeToolGroup', () => {
  it('counts each tool in order of first use', () => {
    const summary = summarizeToolGroup([call('a'), call('b', 'Read'), call('c'), call('d')])
    expect(summary.label).toBe('Bash ×3 · Read')
    expect(summary.state).toBe('completed')
    expect(summary.running).toBeUndefined()
  })

  it('shows the latest running call while any runs, and counts failures', () => {
    const running = call('c', 'Bash', 'streaming')
    const summary = summarizeToolGroup([call('a', 'Bash', 'failed'), call('b'), running])
    expect(summary.running).toBe(running)
    expect(summary.state).toBe('streaming')
    expect(summary.failed).toBe(1)
    expect(summarizeToolGroup([call('a', 'Bash', 'failed'), call('b')]).state).toBe('failed')
    expect(
      summarizeToolGroup([call('a', 'Bash', 'cancelled'), call('b', 'Bash', 'cancelled')]).state
    ).toBe('cancelled')
  })
})
