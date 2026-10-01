import { describe, expect, it } from 'vitest'
import { codexCommand } from './codex.js'

const settings = { codexCommand: 'codex', codexApprovalReviewer: 'user' as const }

describe('codexCommand', () => {
  it('starts on the shared daemon with a workspace-write sandbox and on-request approvals', () => {
    expect(
      codexCommand(settings, { sessionId: 'id', resume: false, cwd: '/work/styr', prompt: '"$P"' })
    ).toBe(
      `codex --remote unix:// --cd '/work/styr' --sandbox workspace-write --ask-for-approval on-request "$P"`
    )
  })

  it('resumes through `codex resume <session-id>` on the same daemon', () => {
    expect(codexCommand(settings, { sessionId: 'abc-123', resume: true, cwd: '/work/styr' })).toBe(
      `codex resume --remote unix:// --cd '/work/styr' --sandbox workspace-write --ask-for-approval on-request abc-123`
    )
  })

  it('quotes a working directory containing spaces and quotes', () => {
    const command = codexCommand(settings, { sessionId: 'id', resume: false, cwd: `/my dir/it's` })
    expect(command).toContain(`--cd '/my dir/it'\\''s'`)
  })

  it('uses automatic approval review without widening the workspace sandbox', () => {
    expect(
      codexCommand(
        { ...settings, codexApprovalReviewer: 'auto_review' },
        { sessionId: 'id', resume: false, cwd: '/w', prompt: 'Implement the task' }
      )
    ).toBe(
      `codex --remote unix:// --cd '/w' --sandbox workspace-write --approve-for-me Implement the task`
    )
  })
})
