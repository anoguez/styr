import { describe, expect, it } from 'vitest'
import type { Task } from '@core/types.js'
import { createWorklogService } from './worklogService.js'

const DAY = Date.parse('2026-03-02T10:00:00Z')

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `Title of ${id}`,
    status: 'in_progress',
    updatedAt: '2026-03-02T12:00:00Z',
    sessions: [{ id: `s-${id}`, provider: 'claude', startedAt: '2026-03-02T10:00:00Z' }],
    ...extra
  } as unknown as Task
}

describe('worklogService', () => {
  it("collects each task's sessions in the span, yielding before each task", async () => {
    const calls: string[] = []
    const service = createWorklogService({
      query: () => [task('TASK-1'), task('TASK-2', { sessions: [] })],
      sources: {
        sessionUsage: (provider, id) => {
          calls.push(`usage ${provider} ${id}`)
          return undefined
        }
      },
      yieldTurn: async () => {
        calls.push('yield')
      }
    })
    const { tasks } = await service.load(DAY - 3_600_000, DAY + 86_400_000)
    expect(tasks.map((entry) => entry.taskId)).toEqual(['TASK-1'])
    expect(tasks[0]!.sessions).toHaveLength(1)
    expect(calls).toEqual(['yield', 'usage claude s-TASK-1', 'yield'])
  })

  it('refuses a span that is not two finite numbers', async () => {
    const service = createWorklogService({
      query: () => [],
      sources: { sessionUsage: () => undefined },
      yieldTurn: async () => {}
    })
    await expect(service.load('1', 2)).rejects.toThrow()
    await expect(service.load(0, Infinity)).rejects.toThrow()
    await expect(service.load(0, 1)).resolves.toEqual({ tasks: [] })
  })
})
