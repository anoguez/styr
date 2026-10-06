import { describe, expect, it } from 'vitest'
import { shippedSettings } from './config.js'
import { planOrchestration } from './orchestrate.js'
import { buildPrompt } from './prompt.js'
import type { Task } from './types.js'

function task(extra: Partial<Task> = {}): Task {
  return {
    id: 'TASK-1',
    title: 'T',
    description: '',
    status: 'backlog',
    priority: 'medium',
    readiness: 'ready',
    tags: [],
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

  it('leaves an In Progress task alone even when it is ready', () => {
    const plan = planOrchestration(shippedSettings(), [task({ status: 'in_progress' })], context)
    expect(plan.dispatch).toEqual([])
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
