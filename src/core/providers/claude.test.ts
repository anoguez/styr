import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { settingsSchema } from '../taskSchema.js'
import { syntaxFor } from '../shell.js'
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
    prompt: '"$P"',
    syntax: syntaxFor('posix')
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

describe('claude fork', () => {
  it('resumes the source as a copy under the new session id', () => {
    const command = claudeProvider.buildCommand({
      settings: {
        storageDir: workspace,
        activeWorkspaceId: 'default',
        claudeCommand: 'claude',
        claudeApprovalMode: 'user'
      } as never,
      taskId: 'T',
      sessionId: 'new-id',
      resume: false,
      forkFrom: 'src-id',
      cwd: '/w',
      syntax: syntaxFor('posix'),
      prompt: '"$P"'
    })
    expect(command).toMatch(/--resume src-id --fork-session --session-id new-id "\$P"$/)
  })
})

describe('claude in PowerShell', () => {
  it('calls the command with & and quotes the PowerShell way', () => {
    const syntax = syntaxFor('powershell')
    const command = claudeProvider.buildCommand({
      settings: {
        storageDir: workspace,
        activeWorkspaceId: 'default',
        claudeCommand: 'claude',
        claudeApprovalMode: 'user'
      } as never,
      taskId: 'T',
      sessionId: 'sid',
      resume: false,
      cwd: '/w',
      prompt: syntax.fileContents("C:\\Users\\o'neil\\T.txt"),
      syntax
    })
    expect(command).toMatch(/^& claude --settings '[^']+T\.json' --session-id sid /)
    expect(command).toMatch(
      /--session-id sid \(Get-Content -Raw -LiteralPath 'C:\\Users\\o''neil\\T\.txt'\)$/
    )
  })
})
