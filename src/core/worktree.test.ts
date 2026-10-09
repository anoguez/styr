import { writeFileSync } from 'node:fs'
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
import {
  removeTemporaryDirectories,
  runGit,
  temporaryDirectory,
  temporaryRepository
} from './gitFixture.js'
import { taskCheckout } from './taskCheckout.js'
import { DEFAULT_WORKSPACE_ID } from './types.js'

function co(repoPath: string, key: string, baseBranch?: string): Checkout {
  return { repoPath, key, baseBranch }
}

afterEach(removeTemporaryDirectories)

describe('worktree management', () => {
  describe('start point', () => {
    function cloneWithOrigin(): { origin: string; clone: string } {
      const origin = temporaryRepository()
      const clone = temporaryDirectory('styr-worktree-clone-')
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

    describe('diff against a release branch', () => {
      function releaseClone(): { clone: string } {
        const { origin, clone } = cloneWithOrigin()
        runGit(['checkout', '-b', 'release/1.1.0'], origin)
        commit(origin, 'release-only.txt')
        runGit(['checkout', 'main'], origin)
        commit(origin, 'main-only.txt')
        runGit(['fetch', 'origin'], clone)
        return { clone }
      }

      function diffPaths(checkout: Checkout): { paths: string[]; baseName?: string } {
        const path = checkoutPath(checkout)
        commit(path, 'task.txt')
        // In the default workspace a checkout's key is its task id.
        const { key: id, repoPath, baseBranch } = checkout
        const diff = taskCheckout(DEFAULT_WORKSPACE_ID, { id, repoPath, baseBranch }).diff()
        if ('error' in diff) throw new Error(diff.error)
        return { paths: diff.files.map((file) => file.path), baseName: diff.baseName }
      }

      it('compares with the branch the user picked', () => {
        const { clone } = releaseClone()
        const checkout = co(clone, 'TASK-0006', 'release/1.1.0')
        ensureWorktree(checkout)

        expect(diffPaths(checkout)).toEqual({ paths: ['task.txt'], baseName: 'release/1.1.0' })
      })

      it('reports the checked-out branch an automatic worktree started from, for its diff', () => {
        const { clone } = releaseClone()
        runGit(['checkout', 'release/1.1.0'], clone)
        const { baseBranch } = ensureWorktree(co(clone, 'TASK-0007'))

        expect(baseBranch).toBe('release/1.1.0')
        expect(diffPaths(co(clone, 'TASK-0007', baseBranch))).toEqual({
          paths: ['task.txt'],
          baseName: 'release/1.1.0'
        })
      })

      it('reports no base when reusing an existing worktree', () => {
        const { clone } = releaseClone()
        ensureWorktree(co(clone, 'TASK-0008', 'release/1.1.0'))

        expect(ensureWorktree(co(clone, 'TASK-0008')).baseBranch).toBeUndefined()
      })
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
      created: true,
      baseBranch: 'main'
    })
    expect(resumed).toEqual({ path: expectedPath, branch: created.branch, created: false })
    expect(isGitRepo(created.path)).toBe(true)
    expect(readGitBranch(created.path)).toBe(created.branch)
  })

  it('rejects a directory that is not a Git repository', () => {
    const directory = temporaryDirectory('styr-not-a-repository-test-')

    expect(() => ensureWorktree(co(directory, 'TASK-0043'))).toThrow(
      `${directory} is not a git repository`
    )
  })
})
