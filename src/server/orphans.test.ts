import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '@core/agentState.js'
import { exitOrphanedAgents } from './orphans.js'

const status = (taskId: string, state: AgentStatus['state']): AgentStatus =>
  ({ taskId, state, at: '2026-10-19T00:00:00.000Z' }) as AgentStatus

describe('exitOrphanedAgents', () => {
  it('marks every agent a dead server left running as exited, in its own workspace', () => {
    const marked: string[] = []
    const count = exitOrphanedAgents({
      workspaceIds: () => ['default', 'beta', 'broken'],
      statuses: (id) => {
        if (id === 'broken') throw new Error('unreadable')
        return id === 'default'
          ? [status('TASK-0001', 'working'), status('TASK-0002', 'exited')]
          : [status('TASK-0001', 'waiting'), status('TASK-0003', 'idle')]
      },
      markExited: (taskId, workspaceId) => void marked.push(`${workspaceId}/${taskId}`)
    })
    // Task ids repeat across workspaces: each is marked in its own.
    expect(marked).toEqual(['default/TASK-0001', 'beta/TASK-0001', 'beta/TASK-0003'])
    expect(count).toBe(3)
  })
})
