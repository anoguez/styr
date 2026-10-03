import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { settingsSchema } from '../taskSchema.js'
import { claudeProvider } from './claude.js'

const workspace = mkdtempSync(join(tmpdir(), 'styr-claude-'))
const build = (claudeApprovalMode: 'user' | 'auto', resume: boolean) =>
  claudeProvider.buildCommand({
    settings: {
      storageDir: workspace,
      activeWorkspaceId: 'default',
      claudeCommand: 'claude',
      claudeApprovalMode
    } as never,
    taskId: 'T',
    sessionId: 'sid',
    resume,
    cwd: '/w',
    prompt: '"$P"'
  })

describe('claude approval mode', () => {
  it('passes no permission flag by default', () => {
    expect(build('user', false)).not.toContain('--permission-mode')
  })

  it('adds auto mode to fresh and resumed launches', () => {
    expect(build('auto', false)).toMatch(/--permission-mode auto --session-id sid "\$P"$/)
    expect(build('auto', true)).toMatch(/--permission-mode auto --resume sid "\$P"$/)
  })

  it('defaults to user when the config predates the setting', () => {
    expect(settingsSchema.shape.claudeApprovalMode.parse(undefined)).toBe('user')
  })
})
