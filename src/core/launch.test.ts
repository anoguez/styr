import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_TEST_TIMEOUT_MS,
  removeTemporaryDirectories,
  runGit,
  temporaryDirectory,
  temporaryRepository
} from './gitFixture.js'
import { supportDir } from './agentStore.js'
import { planLaunch } from './launch.js'
import { launchPatch } from './sessionLifecycle.js'
import { shippedSettings } from './config.js'
import type { Settings, Task } from './types.js'

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS })
afterEach(removeTemporaryDirectories)

function settings(): Settings {
  return { ...shippedSettings(), storageDir: temporaryDirectory('styr-launch-storage-') }
}

function task(repoPath: string, extra: Array<Partial<Task['extraRepos'][number]>>): Task {
  return {
    id: 'TASK-0001',
    title: 'Two repos',
    status: 'backlog',
    priority: 'medium',
    readiness: 'ready',
    description: '',
    activity: [],
    tags: [],
    repoPath,
    orchestrate: true,
    useWorktree: true,
    extraRepos: extra.map((entry) => ({ repoPath: '', ...entry })),
    blockedBy: [],
    contextFiles: [],
    sessions: [],
    questions: [],
    order: 0,
    createdAt: '',
    updatedAt: '',
    filePath: '/tasks/TASK-0001.md',
    format: 'markdown'
  }
}

describe('a multi-repo launch', () => {
  it('cuts a worktree in every repository, starts in the primary and passes the extra dirs', () => {
    const api = temporaryRepository()
    const client = temporaryRepository()
    const docs = temporaryRepository()
    const config = settings()
    const t = task(api, [{ repoPath: client }, { repoPath: docs }])
    const plan = planLaunch(config, t, { provider: 'claude' })

    expect(plan.worktreePath).toBe(plan.cwd)
    expect(plan.extraDirs).toHaveLength(2)
    for (const dir of plan.extraDirs) {
      expect(dir.worktree).toBe(true)
      expect(existsSync(dir.path)).toBe(true)
      expect(runGit(['branch', '--show-current'], dir.path).trim()).toMatch(/^styr\//)
      expect(plan.command).toContain(`--add-dir '${dir.path}'`)
    }
    expect(plan.warning).toBeUndefined()
    expect(plan.extraWorktrees.map((made) => made.baseBranch)).toEqual(['main', 'main'])

    const patch = launchPatch(config, t, plan)
    expect(patch.extraRepos?.map((entry) => [entry.repoPath, entry.baseBranch])).toEqual([
      [client, 'main'],
      [docs, 'main']
    ])
    expect(patch.extraRepos?.[0]?.worktreePath).toBe(plan.extraDirs[0]?.path)
  })

  it('puts every worktree inside its repository when the workspace says so', () => {
    const api = temporaryRepository()
    const client = temporaryRepository()
    const config = { ...settings(), worktreeLocation: 'inside' as const }
    const plan = planLaunch(config, task(api, [{ repoPath: client }]), { provider: 'claude' })

    expect(plan.worktreePath?.startsWith(join(api, '.styr', 'worktrees'))).toBe(true)
    expect(plan.extraDirs[0]?.path.startsWith(join(client, '.styr', 'worktrees'))).toBe(true)
  })

  it('lists the other repositories in the prompt file', () => {
    const api = temporaryRepository()
    const client = temporaryRepository()
    const config = settings()
    const plan = planLaunch(config, task(api, [{ repoPath: client }]), { provider: 'claude' })
    const prompt = readFileSync(join(supportDir(config, 'prompts'), 'TASK-0001.txt'), 'utf8')
    expect(prompt).toContain('This task spans several repositories')
    expect(prompt).toContain(plan.extraDirs[0]?.path)
  })

  it('still starts when one extra cannot get a worktree, and names it in the warning', () => {
    const api = temporaryRepository()
    const client = temporaryRepository()
    const notARepo = temporaryDirectory('styr-not-a-repo-')
    const plan = planLaunch(settings(), task(api, [{ repoPath: notARepo }, { repoPath: client }]), {
      provider: 'claude'
    })
    expect(plan.worktreePath).toBeDefined()
    expect(plan.extraDirs).toEqual([
      { repoPath: notARepo, path: notARepo, worktree: false },
      expect.objectContaining({ repoPath: client, worktree: true })
    ])
    expect(plan.warning).toMatch(/for .+, running in .+ instead/)
    expect(plan.warning).toContain(notARepo)
    expect(plan.extraWorktrees.map((made) => made.repoPath)).toEqual([client])
  })

  it('joins the warnings of several failing repositories with "; "', () => {
    const api = temporaryRepository()
    const one = temporaryDirectory('styr-not-a-repo-')
    const two = temporaryDirectory('styr-not-a-repo-')
    const plan = planLaunch(settings(), task(api, [{ repoPath: one }, { repoPath: two }]), {
      provider: 'claude'
    })
    expect(plan.warning?.split('; ')).toHaveLength(2)
  })

  it('leaves a single-repo launch as it was', () => {
    const api = temporaryRepository()
    const plan = planLaunch(settings(), task(api, []), { provider: 'claude' })
    expect(plan.extraDirs).toEqual([])
    expect(plan.command).not.toContain('--add-dir')
  })

  it('ignores extraRepos when the task has no worktree', () => {
    const api = temporaryRepository()
    const client = temporaryRepository()
    const plan = planLaunch(settings(), {
      ...task(api, [{ repoPath: client }]),
      useWorktree: false
    })
    expect(plan.extraDirs).toEqual([])
    expect(plan.cwd).toBe(api)
  })

  it('re-ensures a worktree removed by hand when resuming', () => {
    const api = temporaryRepository()
    const client = temporaryRepository()
    const config = settings()
    const t = task(api, [{ repoPath: client }])
    const first = planLaunch(config, t, { provider: 'claude' })
    const gone = first.extraDirs[0]?.path as string
    runGit(['worktree', 'remove', '--force', gone], client)
    expect(existsSync(gone)).toBe(false)
    planLaunch(config, t, { provider: 'claude' })
    expect(existsSync(gone)).toBe(true)
  })
})
