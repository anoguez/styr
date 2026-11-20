import { describe, expect, it } from 'vitest'
import type { LaunchOptions } from '@core/launch.js'
import type { LaunchRequest, LaunchResult } from '@core/launchRequests.js'
import type { Settings, Task, TerminalSessionInfo } from '@core/types.js'
import { createLaunchRequestsService } from './launchRequestsService.js'

function task(id: string, extra: Partial<Task> = {}): Task {
  return { id, title: id, status: 'backlog', blockedBy: [], ...extra } as unknown as Task
}

function request(taskId: string, extra: Partial<LaunchRequest> = {}): LaunchRequest {
  return { id: `req-${taskId}`, taskId, at: '2026-01-01T00:00:00Z', ...extra }
}

function harness(tasks: Task[], pending: LaunchRequest[], options: { fail?: string } = {}) {
  const launched: { taskId: string; options: LaunchOptions }[] = []
  const sent: { channel: string; payload?: unknown }[] = []
  const answers: { workspaceId: string; id: string; result: LaunchResult }[] = []
  const claimed: string[] = []
  const service = createLaunchRequestsService({
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    settings: () => ({ activeWorkspaceId: 'default' }) as Settings,
    tasks: () => tasks,
    claim: (workspaceId) => {
      claimed.push(workspaceId)
      return pending.splice(0)
    },
    answer: (workspaceId, id, result) => answers.push({ workspaceId, id, result }),
    launch: async (taskId, launchOptions) => {
      if (options.fail) throw new Error(options.fail)
      launched.push({ taskId, options: launchOptions })
      return { id: `s-${taskId}`, taskId, provider: 'claude' } as TerminalSessionInfo
    }
  })
  return { service, launched, sent, answers, claimed }
}

describe('launch requests (MCP start_task)', () => {
  it("launches the task the way the card's Start does and opens its tab", async () => {
    const h = harness([task('TASK-0001')], [request('TASK-0001')])
    await h.service.process('default')
    expect(h.launched).toEqual([
      { taskId: 'TASK-0001', options: { templateId: undefined, provider: undefined } }
    ])
    expect(h.sent).toEqual([
      {
        channel: 'terminal:launched',
        payload: { id: 's-TASK-0001', taskId: 'TASK-0001', provider: 'claude' }
      }
    ])
    expect(h.answers).toEqual([
      {
        workspaceId: 'default',
        id: 'req-TASK-0001',
        result: { ok: true, sessionId: 's-TASK-0001', taskId: 'TASK-0001', provider: 'claude' }
      }
    ])
  })

  it('passes a chosen template and provider through, as the launch menu does', async () => {
    const h = harness(
      [task('TASK-0001')],
      [request('TASK-0001', { templateId: 'spec', provider: 'codex' })]
    )
    await h.service.process('default')
    expect(h.launched[0]?.options).toEqual({ templateId: 'spec', provider: 'codex' })
  })

  it('warns about open blockers instead of starting, until startAnyway confirms', async () => {
    const tasks = [task('TASK-0001', { blockedBy: ['TASK-0002'] }), task('TASK-0002')]
    const warned = harness(tasks, [request('TASK-0001')])
    await warned.service.process('default')
    expect(warned.launched).toEqual([])
    expect(warned.answers[0]?.result).toMatchObject({ ok: false })
    expect((warned.answers[0]?.result as { error: string }).error).toContain('TASK-0002')

    const confirmed = harness(tasks, [request('TASK-0001', { startAnyway: true })])
    await confirmed.service.process('default')
    expect(confirmed.launched.map((entry) => entry.taskId)).toEqual(['TASK-0001'])
  })

  it('never asks about blockers when the task already has a chat to resume', async () => {
    const tasks = [
      task('TASK-0001', {
        blockedBy: ['TASK-0002'],
        agentSession: { provider: 'claude', id: 'chat' }
      }),
      task('TASK-0002')
    ]
    const h = harness(tasks, [request('TASK-0001')])
    await h.service.process('default')
    expect(h.launched.map((entry) => entry.taskId)).toEqual(['TASK-0001'])
  })

  it('refuses a request from a workspace that is not open, and an unknown task', async () => {
    const other = harness([task('TASK-0001')], [request('TASK-0001')])
    await other.service.process('elsewhere')
    expect(other.launched).toEqual([])
    expect(other.answers[0]).toMatchObject({ workspaceId: 'elsewhere', result: { ok: false } })

    const missing = harness([], [request('TASK-0009')])
    await missing.service.process('default')
    expect(missing.answers[0]?.result).toEqual({ ok: false, error: 'Task TASK-0009 not found' })
  })

  it('answers a failed launch with its reason and opens no tab', async () => {
    const h = harness([task('TASK-0001')], [request('TASK-0001')], {
      fail: 'Codex is not installed'
    })
    await h.service.process('default')
    expect(h.sent).toEqual([])
    expect(h.answers[0]?.result).toEqual({ ok: false, error: 'Codex is not installed' })
  })
})
