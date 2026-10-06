import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  branchNameFor,
  checkoutPath,
  ensureWorktree,
  isGitRepo,
  listBranches,
  readGitBranch,
  type Checkout
} from './worktree.js'
import { branchLanding, cleanupLandedTask, refListing } from './worktreeLanding.js'
import { taskDiff, taskFilePatch } from './worktreeDiff.js'
import { refsFingerprint } from './landing.js'

function co(repoPath: string, key: string, baseBranch?: string): Checkout {
  return { repoPath, key, baseBranch }
}

const temporaryDirectories: string[] = []
const GIT_REPOSITORY_CONTEXT = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_WORK_TREE'
]

function temporaryRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'styr-worktree-test-'))
  temporaryDirectories.push(repository)
  runGit(['init', '--initial-branch=main'], repository)
  runGit(['config', 'user.name', 'Styr test'], repository)
  runGit(['config', 'user.email', 'test@example.com'], repository)
  writeFileSync(join(repository, 'README.md'), '# Test repository\n')
  runGit(['add', 'README.md'], repository)
  runGit(['commit', '-m', 'Initial commit'], repository)
  return repository
}

function runGit(args: string[], cwd: string): string {
  const env = { ...process.env }
  for (const key of GIT_REPOSITORY_CONTEXT) delete env[key]
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('worktree management', () => {
  describe('start point', () => {
    function cloneWithOrigin(): { origin: string; clone: string } {
      const origin = temporaryRepository()
      const clone = mkdtempSync(join(tmpdir(), 'styr-worktree-clone-'))
      temporaryDirectories.push(clone)
      runGit(['clone', origin, clone], tmpdir())
      runGit(['config', 'user.name', 'Styr test'], clone)
      runGit(['config', 'user.email', 'test@example.com'], clone)
      return { origin, clone }
    }

    function commit(repository: string, file: string): string {
      writeFileSync(join(repository, file), file)
      runGit(['add', file], repository)
      runGit(['commit', '-m', file], repository)
      return runGit(['rev-parse', 'HEAD'], repository).trim()
    }

    it('branches from the fetched origin tip when the checkout is behind', () => {
      const { origin, clone } = cloneWithOrigin()
      const upstream = commit(origin, 'new.txt')

      const { path } = ensureWorktree(co(clone, 'TASK-0001'))

      expect(runGit(['rev-parse', 'HEAD'], path).trim()).toBe(upstream)
    })

    it('follows the checked-out release branch rather than the default branch', () => {
      const { origin, clone } = cloneWithOrigin()
      runGit(['checkout', '-b', 'release/1.2.0'], origin)
      commit(origin, 'release.txt')
      runGit(['fetch', 'origin'], clone)
      runGit(['checkout', 'release/1.2.0'], clone)
      const upstream = commit(origin, 'release-next.txt')

      const { path } = ensureWorktree(co(clone, 'TASK-0003'))

      expect(runGit(['rev-parse', 'HEAD'], path).trim()).toBe(upstream)
    })

    it('starts from the branch the user picked', () => {
      const { origin, clone } = cloneWithOrigin()
      runGit(['checkout', '-b', 'release/2.0.0'], origin)
      const release = commit(origin, 'release.txt')
      runGit(['checkout', 'main'], origin)

      const { path } = ensureWorktree(co(clone, 'TASK-0004', 'release/2.0.0'))

      expect(runGit(['rev-parse', 'HEAD'], path).trim()).toBe(release)
    })

    it('falls back to the automatic start when the chosen branch is gone', () => {
      const { clone } = cloneWithOrigin()
      const head = runGit(['rev-parse', 'HEAD'], clone).trim()

      const { path } = ensureWorktree(co(clone, 'TASK-0005', 'deleted-branch'))

      expect(runGit(['rev-parse', 'HEAD'], path).trim()).toBe(head)
    })

    it('lists local and remote branches, current first, hiding task branches', () => {
      const { origin, clone } = cloneWithOrigin()
      runGit(['branch', 'release/1.0.0'], origin)
      runGit(['fetch', 'origin'], clone)
      runGit(['branch', 'styr/TASK-0009'], clone)

      expect(listBranches(clone)).toEqual({
        branches: ['main', 'release/1.0.0'],
        current: 'main'
      })
    })

    it('keeps local commits that origin does not have', () => {
      const { origin, clone } = cloneWithOrigin()
      commit(origin, 'new.txt')
      const local = commit(clone, 'local.txt')

      const { path } = ensureWorktree(co(clone, 'TASK-0002'))

      expect(runGit(['rev-parse', 'HEAD'], path).trim()).toBe(local)
    })
  })

  it('creates a task branch beside the repository and reuses it on resume', () => {
    const repository = temporaryRepository()
    const taskId = 'TASK-0042'
    const expectedPath = checkoutPath(co(repository, taskId))

    const created = ensureWorktree(co(repository, taskId))
    const resumed = ensureWorktree(co(repository, taskId))

    expect(created).toEqual({
      path: expectedPath,
      branch: branchNameFor(taskId),
      created: true
    })
    expect(resumed).toEqual({ ...created, created: false })
    expect(isGitRepo(created.path)).toBe(true)
    expect(readGitBranch(created.path)).toBe(created.branch)
  })

  it('rejects a directory that is not a Git repository', () => {
    const directory = mkdtempSync(join(tmpdir(), 'styr-not-a-repository-test-'))
    temporaryDirectories.push(directory)

    expect(() => ensureWorktree(co(directory, 'TASK-0043'))).toThrow(
      `${directory} is not a git repository`
    )
  })
})

describe('landing and cleanup', () => {
  function commitOnTask(repository: string, taskId: string, file = 'feature.txt'): string {
    const { path, branch } = ensureWorktree(co(repository, taskId))
    writeFileSync(join(path, file), 'work\n')
    runGit(['add', file], path)
    runGit(['commit', '-m', 'Do the work'], path)
    return branch
  }
  const branches = (repository: string): string => runGit(['branch', '--list'], repository)

  it('does not count a fresh branch as landed, nor unmerged commits', () => {
    const repository = temporaryRepository()
    ensureWorktree(co(repository, 'TASK-0050'))
    expect(branchLanding(co(repository, 'TASK-0050'))?.landed).toBe(false)

    commitOnTask(repository, 'TASK-0051')
    expect(branchLanding(co(repository, 'TASK-0051'))).toMatchObject({
      base: 'main',
      ahead: 1,
      landed: false
    })
  })

  it('fingerprints the refs a landing answer depends on, and only those', () => {
    const repository = temporaryRepository()
    const branch = commitOnTask(repository, 'TASK-0060')
    commitOnTask(repository, 'TASK-0061', 'other.txt')
    const before = refsFingerprint(refListing(repository), 'TASK-0060')

    // another task committing again does not matter to this one
    writeFileSync(join(checkoutPath(co(repository, 'TASK-0061')), 'more.txt'), 'x\n')
    runGit(['add', 'more.txt'], checkoutPath(co(repository, 'TASK-0061')))
    runGit(['commit', '-m', 'More'], checkoutPath(co(repository, 'TASK-0061')))
    expect(refsFingerprint(refListing(repository), 'TASK-0060')).toBe(before)

    // the base moving does
    runGit(['merge', '--ff-only', branch], repository)
    expect(refsFingerprint(refListing(repository), 'TASK-0060')).not.toBe(before)
  })

  it('has a stable fingerprint when git cannot list refs', () => {
    expect(refsFingerprint(undefined, 'TASK-0062')).toBe('unavailable')
    expect(refListing('/nonexistent-styr-dir')).toBeUndefined()
  })

  it('cleans up after a fast-forward merge', () => {
    const repository = temporaryRepository()
    const branch = commitOnTask(repository, 'TASK-0052')
    runGit(['merge', '--ff-only', branch], repository)

    expect(branchLanding(co(repository, 'TASK-0052'))).toMatchObject({ ahead: 0, landed: true })
    const result = cleanupLandedTask(co(repository, 'TASK-0052'))
    expect(result.worktreeRemoved).toBe(true)
    expect(existsSync(checkoutPath(co(repository, 'TASK-0052')))).toBe(false)
    expect(branches(repository)).not.toContain(branch)
  })

  it('force-deletes a squash-merged branch only after the content check', () => {
    const repository = temporaryRepository()
    const branch = commitOnTask(repository, 'TASK-0053')
    runGit(['merge', '--squash', branch], repository)
    runGit(['commit', '-m', 'Squashed'], repository)

    expect(branchLanding(co(repository, 'TASK-0053'))).toMatchObject({ ahead: 1, landed: true })
    cleanupLandedTask(co(repository, 'TASK-0053'))
    expect(branches(repository)).not.toContain(branch)
  })

  it('keeps the worktree and branch when the work has not landed', () => {
    const repository = temporaryRepository()
    const branch = commitOnTask(repository, 'TASK-0054')

    const result = cleanupLandedTask(co(repository, 'TASK-0054'))
    expect(result.worktreeRemoved).toBe(false)
    expect(result.notes.join(' ')).toContain('not on main')
    expect(branches(repository)).toContain(branch)
  })

  it('leaves a dirty worktree and its branch in place', () => {
    const repository = temporaryRepository()
    const branch = commitOnTask(repository, 'TASK-0055')
    runGit(['merge', '--ff-only', branch], repository)
    writeFileSync(join(checkoutPath(co(repository, 'TASK-0055')), 'scratch.txt'), 'wip\n')

    const result = cleanupLandedTask(co(repository, 'TASK-0055'))
    expect(result.worktreeRemoved).toBe(false)
    expect(result.notes.join(' ')).toContain('uncommitted')
    expect(branches(repository)).toContain(branch)
  })

  it('measures landing against the task base branch', () => {
    const repository = temporaryRepository()
    runGit(['branch', 'release/1.0'], repository)
    const branch = commitOnTask(repository, 'TASK-0056')
    runGit(['checkout', 'release/1.0'], repository)
    runGit(['merge', '--ff-only', branch], repository)
    runGit(['checkout', 'main'], repository)

    expect(branchLanding(co(repository, 'TASK-0056'))?.landed).toBe(false)
    expect(branchLanding(co(repository, 'TASK-0056', 'release/1.0'))).toMatchObject({
      base: 'release/1.0',
      landed: true
    })
    expect(cleanupLandedTask(co(repository, 'TASK-0056', 'release/1.0')).worktreeRemoved).toBe(true)
  })

  it('falls back to the automatic base when the task base is gone', () => {
    const repository = temporaryRepository()
    commitOnTask(repository, 'TASK-0057')
    expect(branchLanding(co(repository, 'TASK-0057', 'vanished'))).toMatchObject({ base: 'main' })
  })
})

describe('taskDiff', () => {
  it('combines committed, uncommitted, untracked and renamed work', () => {
    const repository = temporaryRepository()
    const { path } = ensureWorktree(co(repository, 'TASK-0001'))
    writeFileSync(join(path, 'committed.txt'), 'one\n')
    runGit(['add', '.'], path)
    runGit(['commit', '-m', 'work'], path)
    runGit(['mv', 'README.md', 'READ ME.md'], path)
    writeFileSync(join(path, 'committed.txt'), 'one\ntwo\n')
    writeFileSync(join(path, 'new file.txt'), 'fresh\n')

    const diff = taskDiff(co(repository, 'TASK-0001'), true)
    if ('error' in diff) throw new Error(diff.error)
    const byPath = Object.fromEntries(diff.files.map((file) => [file.path, file]))
    expect(byPath['committed.txt']).toMatchObject({ status: 'added', additions: 2 })
    expect(byPath['READ ME.md']).toMatchObject({ status: 'renamed', oldPath: 'README.md' })
    expect(byPath['new file.txt']).toMatchObject({
      status: 'added',
      additions: 1,
      origin: 'untracked'
    })
    expect(byPath['committed.txt']).toMatchObject({ origin: 'both', uncommitted: true })
    expect(diff).toMatchObject({ kind: 'changes', baseName: 'main', totalFiles: 3 })

    const patch = taskFilePatch(co(repository, 'TASK-0001'), true, 'new file.txt')
    expect(patch).toHaveProperty('patch')
    expect(taskFilePatch(co(repository, 'TASK-0001'), true, '../etc/passwd')).toEqual({
      placeholder: 'unchanged'
    })
  })

  it('is empty for a branch with no changes and errors without a worktree', () => {
    const repository = temporaryRepository()
    ensureWorktree(co(repository, 'TASK-0002'))
    expect(taskDiff(co(repository, 'TASK-0002'), true)).toMatchObject({
      kind: 'empty',
      files: []
    })
    expect(taskDiff(co(repository, 'TASK-0003'), true)).toMatchObject({ kind: 'gone' })
  })
})
