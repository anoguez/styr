import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { syntaxFor } from '../shell.js'
import { codexCommand, codexSubagentTranscripts, codexTranscriptUsage } from './codex.js'

const settings = { codexCommand: 'codex', codexApprovalReviewer: 'user' as const }

describe('codexCommand', () => {
  it('starts on the shared daemon with a workspace-write sandbox and on-request -c sandbox_workspace_write.network_access=true approvals', () => {
    expect(
      codexCommand(settings, {
        sessionId: 'id',
        resume: false,
        cwd: '/work/styr',
        prompt: '"$P"',
        syntax: syntaxFor('posix')
      })
    ).toBe(
      `codex --remote unix:// --cd '/work/styr' --sandbox workspace-write --ask-for-approval on-request -c sandbox_workspace_write.network_access=true "$P"`
    )
  })

  it('resumes through the daemon without permission overrides', () => {
    const command = codexCommand(
      { ...settings, codexApprovalReviewer: 'auto_review' },
      { sessionId: 'abc-123', resume: true, cwd: '/work/styr', syntax: syntaxFor('posix') }
    )
    expect(command).toBe(`codex resume --remote unix:// --cd '/work/styr' abc-123`)
    expect(command).not.toContain('--approve-for-me')
    expect(command).not.toContain('--sandbox')
    expect(command).not.toContain('--ask-for-approval')
  })

  it('passes a quoted model to fresh, resumed and forked threads', () => {
    const base = { sessionId: 'id', cwd: '/w', model: 'gpt-5-codex', syntax: syntaxFor('posix') }
    expect(codexCommand(settings, { ...base, resume: false })).toContain(
      `--cd '/w' --model 'gpt-5-codex' --sandbox`
    )
    expect(codexCommand(settings, { ...base, resume: true })).toBe(
      `codex resume --remote unix:// --cd '/w' --model 'gpt-5-codex' id`
    )
    expect(codexCommand(settings, { ...base, resume: false, forkFrom: 'src' })).toContain(
      `--model 'gpt-5-codex' --sandbox`
    )
  })

  it('passes no model flag when none is chosen', () => {
    expect(
      codexCommand(settings, {
        sessionId: 'id',
        resume: false,
        cwd: '/w',
        syntax: syntaxFor('posix')
      })
    ).not.toContain('--model')
  })

  it('quotes a working directory containing spaces and quotes', () => {
    const command = codexCommand(settings, {
      sessionId: 'id',
      resume: false,
      cwd: `/my dir/it's`,
      syntax: syntaxFor('posix')
    })
    expect(command).toContain(`--cd '/my dir/it'\\''s'`)
  })

  it('uses automatic approval review without a conflicting --sandbox flag', () => {
    const command = codexCommand(
      { ...settings, codexApprovalReviewer: 'auto_review' },
      {
        sessionId: 'id',
        resume: false,
        cwd: '/w',
        prompt: 'Implement the task',
        syntax: syntaxFor('posix')
      }
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
        syntax: syntaxFor('posix'),
        prompt: '"$P"'
      })
    ).toBe(
      `codex fork --remote unix:// --cd '/w' --sandbox workspace-write --ask-for-approval on-request -c sandbox_workspace_write.network_access=true src-thread "$P"`
    )
  })
})

describe('codexCommand in PowerShell', () => {
  it('calls the command with & and quotes the PowerShell way', () => {
    const command = codexCommand(settings, {
      sessionId: 'id',
      resume: false,
      cwd: "C:\\my dir\\it's",
      syntax: syntaxFor('powershell')
    })
    expect(command.startsWith('& codex --remote unix:// ')).toBe(true)
    expect(command).toContain("--cd 'C:\\my dir\\it''s'")
    expect(command.endsWith(" ''")).toBe(true)
  })
})

describe('codexTranscriptUsage', () => {
  const count = (timestamp: string, input: number, cached: number, output: number): string =>
    JSON.stringify({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output
          }
        }
      }
    })

  it('turns the running totals into calls, leaving cached input out', () => {
    const text = [
      count('2026-10-13T09:00:00Z', 9000, 7000, 100),
      count('2026-10-13T09:00:01Z', 9000, 7000, 100),
      '{"timestamp":"2026-10-13T09:00:30Z","type":"event_msg","payload":{"type":"token_count","info":null}}',
      count('2026-10-13T09:01:00Z', 22000, 15000, 300)
    ].join('\n')
    expect(codexTranscriptUsage(text)).toEqual([
      { at: Date.parse('2026-10-13T09:00:00Z'), tokens: 2100 },
      { at: Date.parse('2026-10-13T09:01:00Z'), tokens: 5200 }
    ])
  })
})

describe('codexSubagentTranscripts', () => {
  const home = mkdtempSync(join(tmpdir(), 'styr-codex-home-'))
  const sessions = join(home, '.codex', 'sessions')
  const meta = (id: string, source: unknown, parent?: string): string =>
    JSON.stringify({
      timestamp: '2026-10-13T09:00:00Z',
      type: 'session_meta',
      payload: {
        id,
        parent_thread_id: parent,
        source,
        base_instructions: { text: 'x'.repeat(70000) }
      }
    })
  const rollout = (date: string, id: string, first: string): string => {
    const dir = join(sessions, date)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-${date.replaceAll('/', '-')}T09-00-00-${id}.jsonl`)
    writeFileSync(file, first)
    return file
  }

  const parent = rollout('2026/10/13', 'p', `${meta('p', 'cli')}\n`)
  const guardian = rollout(
    '2026/10/13',
    'g',
    `${meta('g', { subagent: { other: 'guardian' } }, 'p')}\n`
  )
  const spawned = rollout(
    '2026/10/14',
    's',
    `${meta('s', { subagent: { thread_spawn: { depth: 1 } } }, 'p')}\n{"type":"event_msg"}\n`
  )
  const grandchild = rollout(
    '2026/11/02',
    'gc',
    `${meta('gc', { subagent: { thread_spawn: { depth: 2 } } }, 's')}\n`
  )
  rollout('2026/10/13', 'u', `${meta('u', 'cli')}\n`)
  // Names the parent, but dated before it: never walked.
  rollout('2026/10/12', 'old', `${meta('old', { subagent: { other: 'guardian' } }, 'p')}\n`)
  rollout('2025/12/31', 'older', `${meta('older', { subagent: { other: 'guardian' } }, 'p')}\n`)

  it('finds guardian and spawned children and theirs, from the parent date on', () => {
    expect(codexSubagentTranscripts('p', parent, home)).toEqual([guardian, spawned, grandchild])
  })

  it('reads again a first line that was not complete yet', () => {
    const late = join(sessions, '2026/10/15', 'rollout-late.jsonl')
    mkdirSync(join(sessions, '2026/10/15'), { recursive: true })
    const line = meta('late', { subagent: { other: 'guardian' } }, 'p')
    writeFileSync(late, line.slice(0, 100))
    expect(codexSubagentTranscripts('p', parent, home)).not.toContain(late)
    appendFileSync(late, `${line.slice(100)}\n`)
    expect(codexSubagentTranscripts('p', parent, home)).toContain(late)
  })
})

describe('codexCommand extra directories', () => {
  const base = { sessionId: 'id', cwd: '/w/api', syntax: syntaxFor('posix') }

  it('is byte-identical without any', () => {
    expect(codexCommand(settings, { ...base, resume: false, extraDirs: [] })).toBe(
      codexCommand(settings, { ...base, resume: false })
    )
  })

  it('adds --add-dir after --cd, quoting a path with a space', () => {
    const command = codexCommand(settings, {
      ...base,
      resume: false,
      extraDirs: ['/w/client', '/w/my docs']
    })
    expect(command).toContain(
      `--cd '/w/api' --add-dir '/w/client' --add-dir '/w/my docs' --sandbox workspace-write`
    )
  })

  it('passes them on resume and fork', () => {
    expect(codexCommand(settings, { ...base, resume: true, extraDirs: ['/w/client'] })).toBe(
      `codex resume --remote unix:// --cd '/w/api' --add-dir '/w/client' id`
    )
    expect(
      codexCommand(settings, { ...base, resume: false, forkFrom: 'src', extraDirs: ['/w/c'] })
    ).toContain(`codex fork --remote unix:// --cd '/w/api' --add-dir '/w/c'`)
  })
})
