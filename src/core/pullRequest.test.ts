import { describe, expect, it } from 'vitest'
import { createPullRequestPrompt, createPullRequestsPrompt } from './pullRequest.js'

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

describe('createPullRequestsPrompt', () => {
  const prompt = createPullRequestsPrompt({
    taskFile: '/t.md',
    repos: [
      { name: 'api', path: '/w/api.wt', base: 'main', branch: 'styr/T-1', primary: true },
      {
        name: 'client',
        path: '/w/client.wt',
        base: 'release/2.x',
        branch: 'styr/T-1',
        primary: false
      }
    ]
  })

  it('asks for a pull request per repository with its own base and branch, on one line', () => {
    expect(prompt).not.toContain('\n')
    expect(prompt).toContain('api (in /w/api.wt, branch `styr/T-1`, against `main`')
    expect(prompt).toContain('client (in /w/client.wt, branch `styr/T-1`, against `release/2.x`')
  })

  it('says where each URL is recorded', () => {
    expect(prompt).toContain('record its URL as the top-level `prUrl:`')
    expect(prompt).toContain('`prUrl:` on its `extraRepos` entry')
    expect(prompt).toContain('Leave the status as in_review')
  })
})
