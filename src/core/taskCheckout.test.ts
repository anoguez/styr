import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_TEST_TIMEOUT_MS,
  removeTemporaryDirectories,
  runGit,
  temporaryRepository
} from './gitFixture.js'
import { refsFingerprint } from './landing.js'
import { checkoutGit, taskCheckout, type TaskCheckout } from './taskCheckout.js'
import { DEFAULT_WORKSPACE_ID } from './types.js'
import { checkoutPath, ensureWorktree } from './worktree.js'

function open(
  repoPath: string,
  id: string,
  baseBranch?: string,
  workspaceId = DEFAULT_WORKSPACE_ID
): TaskCheckout {
  return taskCheckout(workspaceId, { id, repoPath, baseBranch })
}

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS })
afterEach(removeTemporaryDirectories)

describe('landing and cleanup', () => {
  function commitOnTask(repository: string, taskId: string, file = 'feature.txt'): string {
    const { path, branch } = ensureWorktree(open(repository, taskId).checkout)
    writeFileSync(join(path, file), 'work\n')
    runGit(['add', file], path)
    runGit(['commit', '-m', 'Do the work'], path)
    return branch
  }
  const branches = (repository: string): string => runGit(['branch', '--list'], repository)

  it('does not count a fresh branch as landed, nor unmerged commits', () => {
    const repository = temporaryRepository()
    ensureWorktree(open(repository, 'TASK-0050').checkout)
    expect(open(repository, 'TASK-0050').landing()?.landed).toBe(false)

    commitOnTask(repository, 'TASK-0051')
    expect(open(repository, 'TASK-0051').landing()).toMatchObject({
      base: 'main',
      ahead: 1,
      landed: false
    })
  })

  it('fingerprints the refs a landing answer depends on, and only those', () => {
    const repository = temporaryRepository()
    const branch = commitOnTask(repository, 'TASK-0060')
    commitOnTask(repository, 'TASK-0061', 'other.txt')
    const before = refsFingerprint(checkoutGit.refListing(repository), 'TASK-0060')

    // another task committing again does not matter to this one
    writeFileSync(join(checkoutPath(open(repository, 'TASK-0061').checkout), 'more.txt'), 'x\n')
    runGit(['add', 'more.txt'], checkoutPath(open(repository, 'TASK-0061').checkout))
    runGit(['commit', '-m', 'More'], checkoutPath(open(repository, 'TASK-0061').checkout))
    expect(refsFingerprint(checkoutGit.refListing(repository), 'TASK-0060')).toBe(before)

    // the base moving does
    runGit(['merge', '--ff-only', branch], repository)
    expect(refsFingerprint(checkoutGit.refListing(repository), 'TASK-0060')).not.toBe(before)
  })

  it('has a stable fingerprint when git cannot list refs', () => {
    expect(refsFingerprint(undefined, 'TASK-0062')).toBe('unavailable')
    expect(checkoutGit.refListing('/nonexistent-styr-dir')).toBeUndefined()
  })

  it('cleans up after a fast-forward merge', () => {
    const repository = temporaryRepository()
    const branch = commitOnTask(repository, 'TASK-0052')
    runGit(['merge', '--ff-only', branch], repository)

    expect(open(repository, 'TASK-0052').landing()).toMatchObject({ ahead: 0, landed: true })
    const result = checkoutGit.cleanupLandedTask(open(repository, 'TASK-0052').checkout)
    expect(result.worktreeRemoved).toBe(true)
    expect(existsSync(checkoutPath(open(repository, 'TASK-0052').checkout))).toBe(false)
    expect(branches(repository)).not.toContain(branch)
  })

  it('force-deletes a squash-merged branch only after the content check', () => {
    const repository = temporaryRepository()
    const branch = commitOnTask(repository, 'TASK-0053')
    runGit(['merge', '--squash', branch], repository)
    runGit(['commit', '-m', 'Squashed'], repository)

    expect(open(repository, 'TASK-0053').landing()).toMatchObject({ ahead: 1, landed: true })
    checkoutGit.cleanupLandedTask(open(repository, 'TASK-0053').checkout)
    expect(branches(repository)).not.toContain(branch)
  })

  it('keeps the worktree and branch when the work has not landed', () => {
    const repository = temporaryRepository()
    const branch = commitOnTask(repository, 'TASK-0054')

    const result = checkoutGit.cleanupLandedTask(open(repository, 'TASK-0054').checkout)
    expect(result.worktreeRemoved).toBe(false)
    expect(result.notes.join(' ')).toContain('not on main')
    expect(branches(repository)).toContain(branch)
  })

  it('leaves a dirty worktree and its branch in place', () => {
    const repository = temporaryRepository()
    const branch = commitOnTask(repository, 'TASK-0055')
    runGit(['merge', '--ff-only', branch], repository)
    writeFileSync(
      join(checkoutPath(open(repository, 'TASK-0055').checkout), 'scratch.txt'),
      'wip\n'
    )

    const result = checkoutGit.cleanupLandedTask(open(repository, 'TASK-0055').checkout)
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

    expect(open(repository, 'TASK-0056').landing()?.landed).toBe(false)
    expect(open(repository, 'TASK-0056', 'release/1.0').landing()).toMatchObject({
      base: 'release/1.0',
      landed: true
    })
    expect(
      checkoutGit.cleanupLandedTask(open(repository, 'TASK-0056', 'release/1.0').checkout)
        .worktreeRemoved
    ).toBe(true)
  })

  it('falls back to the automatic base when the task base is gone', () => {
    const repository = temporaryRepository()
    commitOnTask(repository, 'TASK-0057')
    expect(open(repository, 'TASK-0057', 'vanished').landing()).toMatchObject({ base: 'main' })
  })
})

describe('taskDiff', () => {
  it('combines committed, uncommitted, untracked and renamed work', () => {
    const repository = temporaryRepository()
    const { path } = ensureWorktree(open(repository, 'TASK-0001').checkout)
    writeFileSync(join(path, 'committed.txt'), 'one\n')
    runGit(['add', '.'], path)
    runGit(['commit', '-m', 'work'], path)
    runGit(['mv', 'README.md', 'READ ME.md'], path)
    writeFileSync(join(path, 'committed.txt'), 'one\ntwo\n')
    writeFileSync(join(path, 'new file.txt'), 'fresh\n')

    const diff = open(repository, 'TASK-0001').diff()
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

    const patch = open(repository, 'TASK-0001').filePatch('new file.txt')
    expect(patch).toHaveProperty('patch')
    expect(open(repository, 'TASK-0001').filePatch('../etc/passwd')).toEqual({
      placeholder: 'unchanged'
    })
  })

  it('is empty for a branch with no changes and errors without a worktree', () => {
    const repository = temporaryRepository()
    ensureWorktree(open(repository, 'TASK-0002').checkout)
    expect(open(repository, 'TASK-0002').diff()).toMatchObject({
      kind: 'empty',
      files: []
    })
    expect(open(repository, 'TASK-0003').diff()).toMatchObject({ kind: 'gone' })
  })
})

describe('taskCheckout', () => {
  it('keys the checkout by workspace and task', () => {
    const repository = temporaryRepository()
    const other = open(repository, 'TASK-0004', undefined, 'side')
    expect(other.checkout.key).toBe('side-TASK-0004')
    expect(open(repository, 'TASK-0004').checkout.key).toBe('TASK-0004')

    ensureWorktree(other.checkout)
    expect(other.diff()).toMatchObject({ kind: 'empty' })
    expect(open(repository, 'TASK-0004').diff()).toMatchObject({ kind: 'gone' })
  })

  it('diffs the repository itself for a task without a worktree', () => {
    const repository = temporaryRepository()
    writeFileSync(join(repository, 'README.md'), 'changed\n')
    const checkout = taskCheckout(DEFAULT_WORKSPACE_ID, {
      id: 'TASK-0005',
      repoPath: repository,
      useWorktree: false
    })
    expect(checkout.diff()).toMatchObject({ kind: 'repo', totalFiles: 1 })
    expect(checkout.filePatch('README.md')).toHaveProperty('patch')
  })

  it('removes the worktree', () => {
    const repository = temporaryRepository()
    const checkout = open(repository, 'TASK-0006')
    const { path } = ensureWorktree(checkout.checkout)
    checkout.removeWorktree()
    expect(existsSync(path)).toBe(false)
  })
})
