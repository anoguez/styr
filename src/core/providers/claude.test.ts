import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { settingsSchema } from '../taskSchema.js'
import { syntaxFor } from '../shell.js'
import { claudeProvider, claudeTranscriptUsage } from './claude.js'

const workspace = mkdtempSync(join(tmpdir(), 'styr-claude-'))
const build = (claudeApprovalMode: 'user' | 'auto', resume: boolean, extraDirs?: string[]) =>
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
    extraDirs,
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

describe('claude model', () => {
  const withModel = (model: string | undefined, resume: boolean) =>
    claudeProvider.buildCommand({
      settings: {
        storageDir: workspace,
        activeWorkspaceId: 'default',
        claudeCommand: 'claude',
        claudeApprovalMode: 'user'
      } as never,
      taskId: 'T',
      sessionId: 'sid',
      resume,
      cwd: '/w',
      model,
      syntax: syntaxFor('posix')
    })

  it('passes no model flag when none is chosen, leaving the CLI default', () => {
    expect(withModel(undefined, false)).not.toContain('--model')
  })

  it('passes a quoted model on fresh and resumed launches', () => {
    expect(withModel('opus', false)).toMatch(/ --model 'opus' --session-id sid$/)
    expect(withModel('sonnet[1m]', true)).toMatch(/ --model 'sonnet\[1m\]' --resume sid$/)
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

describe('claudeTranscriptUsage', () => {
  const line = (id: string, timestamp: string, output: number): string =>
    JSON.stringify({
      type: 'assistant',
      timestamp,
      message: {
        id,
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 5000,
          output_tokens: output
        }
      }
    })

  it('counts each message once, without cache reads', () => {
    const text = [
      line('m1', '2026-10-13T09:00:00Z', 10),
      line('m1', '2026-10-13T09:00:02Z', 40),
      '{"type":"user","timestamp":"2026-10-13T09:01:00Z"}',
      'not json "usage"',
      line('m2', '2026-10-13T09:02:00Z', 8)
    ].join('\n')
    expect(claudeTranscriptUsage(text)).toEqual([
      { at: Date.parse('2026-10-13T09:00:00Z'), tokens: 142, id: 'm1' },
      { at: Date.parse('2026-10-13T09:02:00Z'), tokens: 110, id: 'm2' }
    ])
  })
})

describe('claudeTranscriptUsage of an Agent tool result', () => {
  it("ignores the subagent's usage summary the main transcript carries", () => {
    const record = JSON.stringify({
      type: 'user',
      timestamp: '2026-10-13T09:05:00Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }]
      },
      toolUseResult: {
        status: 'completed',
        agentId: 'a440',
        totalTokens: 48210,
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 1200,
          cache_read_input_tokens: 47000,
          output_tokens: 6
        }
      }
    })
    expect(claudeTranscriptUsage(record)).toEqual([])
  })
})

describe('claude subagentTranscripts', () => {
  const project = join(mkdtempSync(join(tmpdir(), 'styr-claude-home-')), '.claude', 'projects', 'p')
  const transcript = join(project, 'sid.jsonl')

  it("lists the session's subagent transcripts, sorted", () => {
    const dir = join(project, 'sid', 'subagents')
    mkdirSync(dir, { recursive: true })
    for (const name of ['agent-b.jsonl', 'agent-a.jsonl', 'agent-a.meta.json'])
      writeFileSync(join(dir, name), '')
    expect(claudeProvider.subagentTranscripts('sid', transcript)).toEqual([
      join(dir, 'agent-a.jsonl'),
      join(dir, 'agent-b.jsonl')
    ])
  })

  it('is empty for a session that started none', () => {
    expect(claudeProvider.subagentTranscripts('other', join(project, 'other.jsonl'))).toEqual([])
  })
})

describe('claude extra directories', () => {
  it('leaves the command unchanged without any', () => {
    expect(build('user', false, [])).toBe(build('user', false))
    expect(build('user', false)).not.toContain('--add-dir')
  })

  it('adds one --add-dir per directory, quoted, before the session', () => {
    expect(build('user', false, ['/w/client', '/w/my docs'])).toMatch(
      / --add-dir '\/w\/client' --add-dir '\/w\/my docs' --session-id sid "\$P"$/
    )
  })

  it('passes them on resume too', () => {
    expect(build('user', true, ['/w/client'])).toMatch(/ --add-dir '\/w\/client' --resume sid/)
  })
})
