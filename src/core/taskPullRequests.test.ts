import { describe, expect, it } from 'vitest'
import { hasAllPullRequests, taskPullRequests } from './taskPullRequests.js'

const base = { repoPath: '/w/api', useWorktree: true, prUrl: undefined, extraRepos: [] as never[] }
const extras = [{ repoPath: '/w/client', prUrl: 'https://x/pull/2' }, { repoPath: '/w/docs' }]

describe('taskPullRequests', () => {
  it('lists the primary first, then each extra that has one, by repository name', () => {
    expect(taskPullRequests({ ...base, prUrl: 'https://x/pull/1', extraRepos: extras })).toEqual([
      { repo: 'api', url: 'https://x/pull/1' },
      { repo: 'client', url: 'https://x/pull/2' }
    ])
  })

  it('lists an extra repository on its own when the primary has none', () => {
    expect(taskPullRequests({ ...base, extraRepos: extras })).toEqual([
      { repo: 'client', url: 'https://x/pull/2' }
    ])
  })

  it('ignores extras on a task without a worktree', () => {
    expect(taskPullRequests({ ...base, useWorktree: false, extraRepos: extras })).toEqual([])
  })
})

describe('hasAllPullRequests', () => {
  it('is false while any repository lacks one, true once all have one', () => {
    const task = { ...base, prUrl: 'https://x/pull/1', extraRepos: extras }
    expect(hasAllPullRequests(task)).toBe(false)
    expect(hasAllPullRequests({ ...task, extraRepos: [extras[0] as (typeof extras)[0]] })).toBe(
      true
    )
    expect(hasAllPullRequests({ ...task, useWorktree: false })).toBe(true)
    expect(hasAllPullRequests({ ...base, extraRepos: [] })).toBe(false)
  })
})
