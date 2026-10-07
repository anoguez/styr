import { describe, expect, it } from 'vitest'
import { buildPrompt } from './prompt.js'
import { DEFAULT_TASK_PRESETS, type Task } from './types.js'
import { shippedSettings } from './config.js'

const base = {
  id: 'TASK-0001',
  title: 'Write a report',
  description: 'Summarise Q3',
  status: 'in_progress',
  priority: 'medium',
  readiness: 'ready',
  tags: [],
  contextFiles: [],
  filePath: '/ws/tasks/TASK-0001.md',
  repoPath: '/notes',
  useWorktree: false
} as unknown as Task

const NO_LANDING = /base branch|pull or merge request|prUrl/

describe('board protocol outside git', () => {
  it('drops landing wording for a plain folder', () => {
    const prompt = buildPrompt('Do it', base, undefined, { plainFolder: true })
    expect(prompt).not.toMatch(NO_LANDING)
    expect(prompt).toContain('status: in_review')
    expect(prompt).toContain('I mark it done')
  })

  it('keeps today’s wording for a repository without a worktree', () => {
    expect(buildPrompt('Do it', base)).toContain('landed on the base branch')
  })

  it('keeps today’s wording for a worktree task', () => {
    const prompt = buildPrompt('Do it', { ...base, useWorktree: true })
    expect(prompt).toContain('landed on the base branch')
    expect(prompt).toContain('dedicated git worktree')
  })
})

describe('shipped defaults', () => {
  it('has no unconditional code-only instruction in implement and review', () => {
    for (const id of ['implement', 'code-review']) {
      const template = shippedSettings().promptTemplates.find((t) => t.id === id)!.template
      expect(template).not.toMatch(/^- Review the open PR/m)
    }
  })

  it('ships Research and Writing presets with the worktree off', () => {
    for (const id of ['research', 'writing']) {
      const preset = DEFAULT_TASK_PRESETS.find((p) => p.id === id)
      expect(preset).toMatchObject({ useWorktree: false, readiness: 'ready' })
    }
  })
})
