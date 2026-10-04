import { describe, expect, it } from 'vitest'
import {
  AGENT_SUMMARY_PENDING,
  agentHandoffPrompt,
  handoffFileName,
  isAgentProgram,
  renderHandoff,
  type HandoffInput
} from './handoff.js'

const base: HandoffInput = {
  cwd: '/repo.worktrees/TASK-0001',
  branch: 'styr/TASK-0001',
  status: ' M src/a.ts',
  diffStat: ' src/a.ts | 2 +-',
  commits: 'abc123 feat: a',
  output: 'line 1\nline 2',
  createdAt: '2026-10-04T11:45:00.000Z',
  source: {
    id: 'TASK-0001',
    title: 'Do the thing',
    status: 'in_progress',
    description: 'Make it work.',
    activity: [{ at: '2026-10-04T11:00:00Z', author: 'claude', message: 'started' }]
  }
}

describe('renderHandoff', () => {
  it('carries the task, branch, repository state and output', () => {
    const doc = renderHandoff(base)
    expect(doc).toContain('# Handoff: Do the thing')
    expect(doc).toContain('Branch: `styr/TASK-0001`')
    expect(doc).toContain('Make it work.')
    expect(doc).toContain('claude: started')
    expect(doc).toContain(' M src/a.ts')
    expect(doc).toContain('line 2')
  })

  it('works for a shell with nothing to report', () => {
    const doc = renderHandoff({
      cwd: '/x',
      status: '',
      diffStat: '',
      commits: '',
      output: '',
      createdAt: base.createdAt
    })
    expect(doc).toContain('# Handoff')
    expect(doc).toContain('(clean)')
    expect(doc).toContain('(nothing captured)')
    expect(doc).not.toContain('Source task')
  })

  it('keeps only the tail of long output', () => {
    const output = Array.from({ length: 500 }, (_, index) => `row ${index}`).join('\n')
    const doc = renderHandoff({ ...base, output })
    expect(doc).toContain('row 499')
    expect(doc).not.toContain('row 100\n')
  })
})

describe('agent summary', () => {
  it('leaves a pending section only when the agent was asked', () => {
    expect(renderHandoff({ ...base, awaitingAgentSummary: true })).toContain(AGENT_SUMMARY_PENDING)
    expect(renderHandoff(base)).not.toContain('## Agent summary')
  })

  it('asks on a single line and names the file', () => {
    const prompt = agentHandoffPrompt('/ws/my folder/handoffs/a.md')
    expect(prompt).not.toContain('\n')
    expect(prompt).toContain('`/ws/my folder/handoffs/a.md`')
  })

  it('recognises only agent CLIs, by program name', () => {
    expect(isAgentProgram('claude --resume x')).toBe(true)
    expect(isAgentProgram('/usr/local/bin/codex --remote unix://')).toBe(true)
    expect(isAgentProgram('pnpm test')).toBe(false)
    expect(isAgentProgram(undefined)).toBe(false)
  })
})

describe('handoffFileName', () => {
  it('names the file after the task and the time', () => {
    expect(handoffFileName(base.source, base.createdAt)).toBe('TASK-0001-20261004-114500.md')
    expect(handoffFileName(undefined, base.createdAt)).toBe('shell-20261004-114500.md')
  })
})
