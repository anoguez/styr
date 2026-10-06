import { describe, expect, it } from 'vitest'
import { codexCommand } from './codex.js'

const settings = { codexCommand: 'codex', codexApprovalReviewer: 'user' as const }

describe('codexCommand', () => {
  it('starts on the shared daemon with a workspace-write sandbox and on-request -c sandbox_workspace_write.network_access=true approvals', () => {
    expect(
      codexCommand(settings, { sessionId: 'id', resume: false, cwd: '/work/styr', prompt: '"$P"' })
    ).toBe(
      `codex --remote unix:// --cd '/work/styr' --sandbox workspace-write --ask-for-approval on-request -c sandbox_workspace_write.network_access=true "$P"`
    )
  })

  it('resumes through the daemon without permission overrides', () => {
    const command = codexCommand(
      { ...settings, codexApprovalReviewer: 'auto_review' },
      { sessionId: 'abc-123', resume: true, cwd: '/work/styr' }
    )
    expect(command).toBe(`codex resume --remote unix:// --cd '/work/styr' abc-123`)
    expect(command).not.toContain('--approve-for-me')
    expect(command).not.toContain('--sandbox')
    expect(command).not.toContain('--ask-for-approval')
  })

  it('quotes a working directory containing spaces and quotes', () => {
    const command = codexCommand(settings, { sessionId: 'id', resume: false, cwd: `/my dir/it's` })
    expect(command).toContain(`--cd '/my dir/it'\\''s'`)
  })

  it('uses automatic approval review without a conflicting --sandbox flag', () => {
    const command = codexCommand(
      { ...settings, codexApprovalReviewer: 'auto_review' },
      { sessionId: 'id', resume: false, cwd: '/w', prompt: 'Implement the task' }
    )
    expect(command).toBe(
      `codex --remote unix:// --cd '/w' --approve-for-me -c sandbox_workspace_write.network_access=true Implement the task`
    )
    expect(command).not.toContain('--sandbox')
  })

  it('forks a thread on the daemon with the same policy and the prompt', () => {
    expect(
      codexCommand(settings, {
        sessionId: 'new',
        resume: false,
        forkFrom: 'src-thread',
        cwd: '/w',
        prompt: '"$P"'
      })
    ).toBe(
      `codex fork --remote unix:// --cd '/w' --sandbox workspace-write --ask-for-approval on-request -c sandbox_workspace_write.network_access=true src-thread "$P"`
    )
  })
})
