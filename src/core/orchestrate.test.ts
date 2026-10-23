import { describe, expect, it } from 'vitest'
import { shippedSettings } from './config.js'
import { planOrchestration } from './orchestrate.js'
import { buildPrompt } from './prompt.js'
import type { AgentState, Task } from './types.js'

function task(extra: Partial<Task> = {}): Task {
  return {
    id: 'TASK-1',
    title: 'T',
    description: '',
    status: 'backlog',
    priority: 'medium',
    readiness: 'ready',
    tags: [],
    blockedBy: [],
    contextFiles: [],
    orchestrate: true,
    repoPath: '/repo',
    filePath: '/tasks/TASK-1.md',
    order: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra
  } as unknown as Task
}

const context = { liveTaskIds: new Set<string>(), agents: new Map() }

describe('planOrchestration', () => {
  it('dispatches a specified Backlog task', () => {
    const plan = planOrchestration(shippedSettings(), [task()], context)
    expect(plan.dispatch.map((d) => d.task.id)).toEqual(['TASK-1'])
  })

  it('holds back a task until every blocker is Done, in any lane', () => {
    const blocker = task({ id: 'TASK-2', status: 'in_progress' })
    const blocked = task({ blockedBy: ['TASK-2'] })
    const review = task({ id: 'TASK-3', status: 'in_review', blockedBy: ['TASK-2'] })
    const held = planOrchestration(shippedSettings(), [blocker, blocked, review], context)
    expect(held.dispatch).toEqual([])
    expect(held.blocked).toBe(2)

    const done = { ...blocker, status: 'done' as const }
    const freed = planOrchestration(shippedSettings(), [done, blocked, review], context)
    expect(freed.dispatch.map((d) => d.task.id).sort()).toEqual(['TASK-1', 'TASK-3'])
    expect(freed.blocked).toBe(0)
  })

  it('ignores an unknown blocker and holds both ends of a cycle', () => {
    const dangling = task({ blockedBy: ['TASK-99'] })
    expect(planOrchestration(shippedSettings(), [dangling], context).dispatch).toHaveLength(1)

    const a = task({ id: 'TASK-1', blockedBy: ['TASK-2'] })
    const b = task({ id: 'TASK-2', blockedBy: ['TASK-1'] })
    expect(planOrchestration(shippedSettings(), [a, b], context).dispatch).toEqual([])
  })

  it('leaves an In Progress task alone even when it is ready', () => {
    const plan = planOrchestration(shippedSettings(), [task({ status: 'in_progress' })], context)
    expect(plan.dispatch).toEqual([])
  })
})

describe('lane occupancy', () => {
  const settings = () => ({
    ...shippedSettings(),
    orchestration: { spec: 3, implement: 0, review: 0 }
  })
  const specs = (n: number, extra: Partial<Task> = {}) =>
    Array.from({ length: n }, (_, i) =>
      task({ id: `TASK-${i + 1}`, readiness: 'needs_spec', order: i, ...extra })
    )
  const agentsFor = (ids: string[], state: AgentState) =>
    new Map(ids.map((id) => [id, state] as const))

  it('starts exactly the limit on the first pass', () => {
    const plan = planOrchestration(settings(), specs(6), context)
    expect(plan.dispatch).toHaveLength(3)
  })

  it('counts a ready agent against its lane', () => {
    const running = specs(3, { status: 'in_progress' })
    const waiting = specs(3).map((t, i) => ({ ...t, id: `TASK-${i + 10}` }))
    const agents = agentsFor(['TASK-1', 'TASK-2', 'TASK-3'], 'ready')
    const plan = planOrchestration(settings(), [...running, ...waiting], {
      liveTaskIds: new Set(),
      agents
    })
    expect(plan.occupied.spec).toBe(3)
    expect(plan.dispatch).toEqual([])
  })

  it('frees a slot when an agent goes idle or exits', () => {
    for (const state of ['idle', 'exited'] as const) {
      const running = specs(3, { status: 'in_progress' })
      const waiting = [task({ id: 'TASK-10', readiness: 'needs_spec' })]
      const agents = agentsFor(['TASK-1', 'TASK-2', 'TASK-3'], 'ready')
      agents.set('TASK-1', state)
      const plan = planOrchestration(settings(), [...running, ...waiting], {
        liveTaskIds: new Set(),
        agents
      })
      expect(plan.dispatch.map((d) => d.task.id)).toEqual(['TASK-10'])
    }
  })

  it('keeps lanes independent and a limit of 0 closed', () => {
    const running = specs(3, { status: 'in_progress' })
    const impl = task({ id: 'TASK-10' })
    const agents = agentsFor(['TASK-1', 'TASK-2', 'TASK-3'], 'ready')
    const open = { ...settings(), orchestration: { spec: 3, implement: 1, review: 0 } }
    const ctx = { liveTaskIds: new Set<string>(), agents }
    expect(planOrchestration(open, [...running, impl], ctx).dispatch).toHaveLength(1)
    expect(planOrchestration(settings(), [...running, impl], ctx).dispatch).toEqual([])
  })
})

describe('spec hand-off wording', () => {
  const spec = shippedSettings().promptTemplates.find((t) => t.id === 'spec')!.template

  it('tells a spec run to return the task to Backlog unless it carries on building', () => {
    const prompt = buildPrompt(spec, task({ readiness: 'needs_spec' }))
    expect(prompt).toContain('set `status: backlog` together with `readiness: ready`')
    expect(prompt).toContain('Leave the status at in_progress only if you carry straight on')
  })

  it('adds the Backlog hand-off to every prompt, whatever the template', () => {
    expect(buildPrompt('Just do {{title}}', task())).toContain(
      'set `status: backlog` with `readiness: ready`'
    )
  })
})
