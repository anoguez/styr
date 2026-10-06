import { describe, expect, it } from 'vitest'
import { askDraft, handoffDraft, terminalDraft } from './derivedTask.js'

const settings = {
  defaultRepoPath: ' /repo ',
  defaultProvider: 'codex' as const,
  taskDefaults: { orchestrate: true, useWorktree: true }
}

describe('derived task drafts', () => {
  it('are never orchestrated, even when the settings default says so', () => {
    const drafts = [
      askDraft({
        title: 'q',
        description: 'd',
        source: { priority: 'high' },
        cwd: '/w',
        provider: 'claude'
      }),
      handoffDraft({ title: 't', description: 'd', document: '/h.md' }, settings),
      terminalDraft({ title: 't', description: 'd' }, settings),
      terminalDraft({ title: 't', description: 'd', ready: true, launch: true }, settings)
    ]
    for (const draft of drafts) expect(draft.orchestrate).toBe(false)
  })

  it('ask inherits priority and runs in the source directory without a worktree', () => {
    const draft = askDraft({
      title: 'q',
      description: 'd',
      source: { priority: 'high' },
      cwd: '/w',
      provider: 'claude'
    })
    expect(draft).toMatchObject({
      priority: 'high',
      repoPath: '/w',
      useWorktree: false,
      readiness: 'ready',
      tags: ['ask']
    })
  })

  it('handoff carries the source and falls back to the settings', () => {
    const draft = handoffDraft({ title: 't', description: 'd', document: '/h.md' }, settings)
    expect(draft).toMatchObject({
      priority: 'medium',
      repoPath: '/repo',
      useWorktree: true,
      provider: 'codex',
      tags: ['handoff'],
      contextFiles: ['/h.md']
    })
  })

  it('terminal drafts need a spec unless ready, and a question gets no worktree', () => {
    expect(terminalDraft({ title: 't', description: 'd' }, settings)).toMatchObject({
      readiness: 'needs_spec',
      useWorktree: true,
      repoPath: '/repo'
    })
    expect(
      terminalDraft(
        { title: 't', description: 'd', ready: true, launch: true, repoPath: '/x' },
        settings
      )
    ).toMatchObject({
      readiness: 'ready',
      useWorktree: false,
      repoPath: '/x'
    })
  })
})
