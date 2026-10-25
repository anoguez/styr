import { describe, expect, it } from 'vitest'
import { buildPrompt, reposBlock, type PromptRepo } from './prompt.js'
import type { Task } from './types.js'

const task: Task = {
  id: 'TASK-0007',
  title: 'Add a field',
  status: 'in_progress',
  priority: 'medium',
  readiness: 'ready',
  description: 'Spec',
  activity: [],
  tags: [],
  repoPath: '/w/api.worktrees/x',
  orchestrate: true,
  useWorktree: true,
  extraRepos: [],
  blockedBy: [],
  contextFiles: [],
  sessions: [],
  questions: [],
  order: 0,
  createdAt: '',
  updatedAt: '',
  filePath: '/tasks/TASK-0007.md',
  format: 'markdown'
}

const extra: PromptRepo = {
  name: 'client',
  path: '/w/client.worktrees/x',
  baseBranch: 'release/2.x',
  branch: 'styr/TASK-0007'
}

describe('multi-repo prompt', () => {
  it('says nothing about repositories for a single-repo task', () => {
    const prompt = buildPrompt('Do {{title}}', task, undefined, { primaryName: 'api' })
    expect(prompt).not.toContain('Repositories')
    expect(prompt).not.toContain('extraRepos')
    expect(prompt).toContain('landed on the base branch')
    expect(buildPrompt('{{repos}}|', task)).toContain('|')
  })

  it('lists every other repo with path, base and branch', () => {
    const prompt = buildPrompt('Do {{title}}', task, undefined, {
      primaryName: 'api',
      extraRepos: [extra]
    })
    expect(prompt).toContain('You started in `api` (the primary)')
    expect(prompt).toContain('branch `styr/TASK-0007`')
    expect(prompt).toContain('- client at /w/client.worktrees/x (base release/2.x)')
    expect(prompt).toContain("every repository's branch has landed on its base")
    expect(prompt).toMatch(/`prUrl:` on the matching\s+`extraRepos` entry/)
  })

  it('places the list where a template asks, and only once', () => {
    const prompt = buildPrompt('Review:\n{{repos}}\nEnd', task, undefined, {
      primaryName: 'api',
      extraRepos: [extra]
    })
    expect(prompt.match(/This task spans several repositories/g)).toHaveLength(1)
    expect(prompt.indexOf('Review:')).toBeLessThan(prompt.indexOf('spans several'))
    expect(prompt.indexOf('spans several')).toBeLessThan(prompt.indexOf('End'))
    // Per-repo Done and PR wording still applies.
    expect(prompt).toContain('`extraRepos` entry')
  })

  it('renders nothing for no extra repos', () => {
    expect(reposBlock('api', [])).toBe('')
  })
})
