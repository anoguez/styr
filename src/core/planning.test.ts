import { describe, expect, it } from 'vitest'
import { isPlanRun, planningPrompt, planTitle, PLAN_RUN_TAG } from './planning.js'
import { planDraft } from './derivedTask.js'

describe('planningPrompt', () => {
  it('carries the request verbatim', () => {
    expect(planningPrompt('  add dark mode\nand a toggle ')).toContain(
      'add dark mode\nand a toggle'
    )
  })

  it('tells the agent what to do when the Styr tools are missing', () => {
    const prompt = planningPrompt('x')
    expect(prompt).toContain("If you cannot see Styr's task tools")
    expect(prompt).toContain('Markdown list')
    expect(prompt).toContain('Settings → Integrations')
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
