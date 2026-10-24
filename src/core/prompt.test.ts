import { describe, expect, it } from 'vitest'
import { buildPrompt } from './prompt.js'
import type { Task } from './types.js'

const base = {
  id: 'TASK-0001',
  title: 'Do it',
  description: 'Spec',
  status: 'in_progress',
  priority: 'medium',
  readiness: 'ready',
  tags: [],
  contextFiles: [],
  questions: [],
  filePath: '/ws/tasks/TASK-0001.md',
  repoPath: '/repo',
  useWorktree: false
} as unknown as Task

describe('board protocol tools', () => {
  it('names the three tools first and the file edits as the fallback', () => {
    const prompt = buildPrompt('Go', { ...base, readiness: 'needs_spec' })
    expect(prompt).toContain('call `request_review` on the styr MCP server')
    expect(prompt).toContain(
      'Only if you do not have that tool, write a `## Handoff` section above'
    )
    expect(prompt).toContain('set `status: in_review`')
    expect(prompt).toContain('call `ask_owner`')
    expect(prompt).toMatch(/also put the same question to me in this conversation/)
    expect(prompt).toContain('`resolve_question`')
    expect(prompt).toContain('add the question under `questions:` in the frontmatter')
    expect(prompt).toContain('split it with `split_task`')
    expect(prompt).toMatch(/add\s+their ids to this task's `blockedBy`/)
  })

  it('offers the split only while the task needs a spec', () => {
    expect(buildPrompt('Go', base)).not.toContain('split_task')
  })

  it('keeps the file-edit lines, so an agent without the tools still works', () => {
    const prompt = buildPrompt('Go', base)
    expect(prompt).toContain('- Set `status: in_progress` as soon as you start')
    expect(prompt).toContain('record it with `blockedBy: [TASK-xxxx]`')
  })

  it('says where the deliverable is in a plain folder', () => {
    const prompt = buildPrompt('Go', base, undefined, { plainFolder: true })
    expect(prompt).toContain('call `request_review`')
    expect(prompt).toContain('Put the deliverable in the working directory')
    expect(prompt).not.toContain('landed on the base branch')
  })
})

describe('questions for the owner', () => {
  const asked = {
    ...base,
    questions: [
      { id: 'q1', askedAt: 'a', askedBy: 'claude', text: 'Copy files?', answer: 'Yes, all.' },
      { id: 'q2', askedAt: 'b', askedBy: 'claude', text: 'Which base?' }
    ]
  } as Task

  it('lists answered and open questions, for any template', () => {
    const prompt = buildPrompt('Custom {{id}}', asked)
    expect(prompt).toContain('## Questions for the owner')
    expect(prompt).toContain('- q1: Copy files?\n  Answer: Yes, all.')
    expect(prompt).toContain('- q2 (open): Which base?')
  })

  it('renders nothing when there are none', () => {
    expect(buildPrompt('Go', base)).not.toContain('Questions for the owner')
  })
})
