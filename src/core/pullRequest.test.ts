import { describe, expect, it } from 'vitest'
import { createPullRequestPrompt } from './pullRequest.js'

describe('createPullRequestPrompt', () => {
  it('names the base branch and the task file, on one line', () => {
    const prompt = createPullRequestPrompt({ taskFile: '/ws/tasks/TASK-1 x.md', base: 'main' })
    expect(prompt).not.toContain('\n')
    expect(prompt).toContain('against `main`')
    expect(prompt).toContain('`/ws/tasks/TASK-1 x.md`')
    expect(prompt).toContain('prUrl:')
  })

  it('does not invent a base branch', () => {
    expect(createPullRequestPrompt({ taskFile: '/t.md' })).toContain('against the base branch')
  })

  it('does not assume a host and leaves the status alone', () => {
    const prompt = createPullRequestPrompt({ taskFile: '/t.md', base: 'main' })
    expect(prompt).toContain('if the repo has a GitHub remote')
    expect(prompt).toContain('Leave the status as in_review')
  })
})
