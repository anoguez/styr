import { describe, expect, it } from 'vitest'
import { isPlanRun, planningPrompt, planTitle, PLAN_RUN_TAG } from './planning.js'
import { planDraft } from './derivedTask.js'

describe('planningPrompt', () => {
  it('carries the request verbatim', () => {
    expect(planningPrompt('  add dark mode\nand a toggle ')).toContain(
      'add dark mode\nand a toggle'
    )
  })

  it('follows the request: names the tools, creates tasks only when asked', () => {
    const prompt = planningPrompt('anything')
    expect(prompt).not.toContain('Turn the request below')
    for (const tool of ['list_tasks', 'create_task', 'update_task', 'set_task_status']) {
      expect(prompt).toContain(tool)
    }
    expect(prompt).toContain('Create tasks only if the request says to')
  })

  it('tells the agent what to do when the Styr tools are missing', () => {
    const prompt = planningPrompt('x')
    expect(prompt).toContain('cannot see them')
    expect(prompt).toContain('Markdown list')
    expect(prompt).toContain('Settings → Integrations')
  })
})

describe('planningPrompt with a preset', () => {
  const preset = {
    id: 'bug',
    name: 'Bug',
    title: '',
    description: '## Steps to reproduce\n',
    tags: ['bug'],
    priority: 'high' as const,
    readiness: 'ready' as const,
    useWorktree: true,
    orchestrate: true
  }

  it("carries the preset's prompt and defaults", () => {
    const prompt = planningPrompt('login breaks', preset)
    expect(prompt).toContain('"Bug" preset')
    expect(prompt).toContain('## Steps to reproduce')
    expect(prompt).toContain('priority high; readiness ready; tags bug')
  })

  it('is unchanged without a preset', () => {
    expect(planningPrompt('x')).not.toContain('preset')
  })
})

describe('plan runs', () => {
  const settings = {
    defaultRepoPath: ' /repo ',
    defaultProvider: 'codex' as const,
    taskDefaults: { orchestrate: true, useWorktree: true }
  }

  it('are tagged, branchless, ready and never orchestrated', () => {
    const draft = planDraft({ title: planTitle('plan it'), description: 'd' }, settings)
    expect(draft).toMatchObject({
      tags: [PLAN_RUN_TAG],
      readiness: 'ready',
      useWorktree: false,
      orchestrate: false,
      provider: 'codex',
      repoPath: '/repo'
    })
    expect(isPlanRun({ tags: draft.tags ?? [] })).toBe(true)
    expect(isPlanRun({ tags: ['plan'] })).toBe(false)
  })
})
