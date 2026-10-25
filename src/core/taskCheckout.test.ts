import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_TEST_TIMEOUT_MS,
  removeTemporaryDirectories,
  runGit,
  temporaryDirectory,
  temporaryRepository
} from './gitFixture.js'
import { refsFingerprint } from './landing.js'
import {
  checkoutGit,
  checkoutOf,
  checkoutsOf,
  taskCheckout,
  type TaskCheckout
} from './taskCheckout.js'
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

/** Every asynchronous git invocation's arguments, so a test can see which processes ran. */
const asyncGit = vi.hoisted(() => [] as string[][])

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: ((file: string, args: string[], ...rest: unknown[]) => {
      if (file === 'git') asyncGit.push(args)
      return (actual.execFile as (...all: unknown[]) => unknown)(file, args, ...rest)
    }) as typeof actual.execFile
  }
})

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

  it('fingerprints the refs a landing answer depends on, and only those', async () => {
    const repository = temporaryRepository()
    const branch = commitOnTask(repository, 'TASK-0060')
    commitOnTask(repository, 'TASK-0061', 'other.txt')
    const before = refsFingerprint(await checkoutGit.refListing(repository), 'TASK-0060')

    // another task committing again does not matter to this one
    writeFileSync(join(checkoutPath(open(repository, 'TASK-0061').checkout), 'more.txt'), 'x\n')
    runGit(['add', 'more.txt'], checkoutPath(open(repository, 'TASK-0061').checkout))
    runGit(['commit', '-m', 'More'], checkoutPath(open(repository, 'TASK-0061').checkout))
    expect(refsFingerprint(await checkoutGit.refListing(repository), 'TASK-0060')).toBe(before)

    // the base moving does
    runGit(['merge', '--ff-only', branch], repository)
    expect(refsFingerprint(await checkoutGit.refListing(repository), 'TASK-0060')).not.toBe(before)
  })

  it('has a stable fingerprint when git cannot list refs', async () => {
    expect(refsFingerprint(undefined, 'TASK-0062')).toBe('unavailable')
    expect(await checkoutGit.refListing('/nonexistent-styr-dir')).toBeUndefined()
  })

  it('cleans up after a fast-forward merge', async () => {
    const repository = temporaryRepository()
    const branch = commitOnTask(repository, 'TASK-0052')
    runGit(['merge', '--ff-only', branch], repository)

    expect(open(repository, 'TASK-0052').landing()).toMatchObject({ ahead: 0, landed: true })
    const result = await checkoutGit.cleanupLandedTask(open(repository, 'TASK-0052').checkout)
    expect(result.worktreeRemoved).toBe(true)
    expect(existsSync(checkoutPath(open(repository, 'TASK-0052').checkout))).toBe(false)
    expect(branches(repository)).not.toContain(branch)
  })

  it('never deletes the remote branch, even when it matches the landed local one', async () => {
    const repository = temporaryRepository()
    const remote = temporaryDirectory('styr-remote-')
    runGit(['init', '--bare', '--quiet', remote], remote)
    runGit(['remote', 'add', 'origin', remote], repository)
    const branch = commitOnTask(repository, 'TASK-0057')
    runGit(['push', '--quiet', 'origin', branch], repository)
    runGit(['merge', '--ff-only', branch], repository)

    const result = await checkoutGit.cleanupLandedTask(open(repository, 'TASK-0057').checkout)
    expect(branches(repository)).not.toContain(branch)
    expect(runGit(['branch', '--list', branch], remote)).toContain(branch)
    expect(result.notes.join(' ')).not.toMatch(/remote/i)
  })

  it('force-deletes a squash-merged branch only after the content check', async () => {
    const repository = temporaryRepository()
    const branch = commitOnTask(repository, 'TASK-0053')
    runGit(['merge', '--squash', branch], repository)
    runGit(['commit', '-m', 'Squashed'], repository)

    expect(open(repository, 'TASK-0053').landing()).toMatchObject({ ahead: 1, landed: true })
    await checkoutGit.cleanupLandedTask(open(repository, 'TASK-0053').checkout)
    expect(branches(repository)).not.toContain(branch)
  })

  it('sees a squash merge after the base has changed the same files again', async () => {
    const repository = temporaryRepository()
    writeFileSync(join(repository, 'notes.txt'), 'one\ntwo\nthree\nfour\n')
    runGit(['add', 'notes.txt'], repository)
    runGit(['commit', '-m', 'Add notes'], repository)
    const { path, branch } = ensureWorktree(open(repository, 'TASK-0058').checkout)
    const edits: [string, string][] = [
      ['README.md', '# Test repository\nwork\n'],
      ['feature.txt', 'work\n']
    ]
    for (const [file, text] of edits) {
      writeFileSync(join(path, file), text)
      runGit(['add', file], path)
      runGit(['commit', '-m', `Change ${file}`], path)
    }
    // a rename: a squash commit's patch is only recognised when read whole, not cut to these paths
    runGit(['mv', 'notes.txt', 'docs.txt'], path)
    runGit(['commit', '-m', 'Rename the notes'], path)
    runGit(['merge', '--squash', branch], repository)
    runGit(['commit', '-m', 'Squashed (#1)'], repository)
    writeFileSync(join(repository, 'README.md'), '# Test repository\nwork\nbadge\n')
    runGit(['commit', '-am', 'Refresh the badge'], repository)

    expect(open(repository, 'TASK-0058').landing()).toMatchObject({ ahead: 3, landed: true })
    expect(
      await checkoutGit.cleanupLandedTask(open(repository, 'TASK-0058').checkout)
    ).toMatchObject({ worktreeRemoved: true })
    expect(branches(repository)).not.toContain(branch)
  })

  it('cleans up a branch with no commits of its own without calling it landed', async () => {
    const repository = temporaryRepository()
    const { path, branch } = ensureWorktree(open(repository, 'TASK-0059').checkout)
    expect(open(repository, 'TASK-0059').landing()).toMatchObject({ ahead: 0, landed: false })

    const result = await checkoutGit.cleanupLandedTask(open(repository, 'TASK-0059').checkout)
    expect(result.worktreeRemoved).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(branches(repository)).not.toContain(branch)
  })

  it('keeps a branch that moved after it was measured', async () => {
    const repository = temporaryRepository()
    const { path, branch } = ensureWorktree(open(repository, 'TASK-0063').checkout)
    const measured = open(repository, 'TASK-0063').landing()
    writeFileSync(join(path, 'late.txt'), 'late\n')
    runGit(['add', 'late.txt'], path)
    runGit(['commit', '-m', 'Late work'], path)

    const result = await checkoutGit.cleanupLandedTask(
      open(repository, 'TASK-0063').checkout,
      measured
    )
    expect(result.notes.join(' ')).toContain('Could not delete local branch')
    expect(branches(repository)).toContain(branch)
  })

  it('keeps the worktree and branch when the work has not landed', async () => {
    const repository = temporaryRepository()
    const branch = commitOnTask(repository, 'TASK-0054')

    const result = await checkoutGit.cleanupLandedTask(open(repository, 'TASK-0054').checkout)
    expect(result.worktreeRemoved).toBe(false)
    expect(result.notes.join(' ')).toContain('not on main')
    expect(branches(repository)).toContain(branch)
  })

  it('leaves a dirty worktree and its branch in place', async () => {
    const repository = temporaryRepository()
    const branch = commitOnTask(repository, 'TASK-0055')
    runGit(['merge', '--ff-only', branch], repository)
    writeFileSync(
      join(checkoutPath(open(repository, 'TASK-0055').checkout), 'scratch.txt'),
      'wip\n'
    )

    const result = await checkoutGit.cleanupLandedTask(open(repository, 'TASK-0055').checkout)
    expect(result.worktreeRemoved).toBe(false)
    expect(result.notes.join(' ')).toContain('uncommitted')
    expect(branches(repository)).toContain(branch)
  })

  it('measures landing against the task base branch', async () => {
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
      (await checkoutGit.cleanupLandedTask(open(repository, 'TASK-0056', 'release/1.0').checkout))
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

describe('worktree location', () => {
  const repoPath = '/projects/app'
  const beside = checkoutPath({ repoPath, key: 'TASK-0070', location: 'beside' })
  const inside = checkoutPath({ repoPath, key: 'TASK-0070', location: 'inside' })

  it('places a worktree yet to be made by the workspace setting', () => {
    expect(checkoutOf(DEFAULT_WORKSPACE_ID, { id: 'TASK-0070' }, repoPath).location).toBe('beside')
    expect(checkoutOf(DEFAULT_WORKSPACE_ID, { id: 'TASK-0070' }, repoPath, 'inside').location).toBe(
      'inside'
    )
  })

  it('keeps an existing worktree where it was made, whatever the setting says now', () => {
    const task = (worktreePath: string): { id: string; worktreePath: string } => ({
      id: 'TASK-0070',
      worktreePath
    })
    expect(checkoutPath(checkoutOf(DEFAULT_WORKSPACE_ID, task(beside), repoPath, 'inside'))).toBe(
      beside
    )
    expect(checkoutPath(checkoutOf(DEFAULT_WORKSPACE_ID, task(inside), repoPath, 'beside'))).toBe(
      inside
    )
  })

  it('never takes a recorded path it could not have made', () => {
    const task = { id: 'TASK-0070', worktreePath: '/somewhere/else' }
    expect(checkoutPath(checkoutOf(DEFAULT_WORKSPACE_ID, task, repoPath, 'inside'))).toBe(inside)
  })

  it('removes a worktree made inside the repository', () => {
    const repository = temporaryRepository()
    const made = taskCheckout(
      DEFAULT_WORKSPACE_ID,
      { id: 'TASK-0071', repoPath: repository },
      'inside'
    )
    const { path } = ensureWorktree(made.checkout)
    // The setting has since gone back to beside; the recorded path still finds the worktree.
    taskCheckout(DEFAULT_WORKSPACE_ID, {
      id: 'TASK-0071',
      repoPath: repository,
      worktreePath: path
    }).removeWorktree()
    expect(existsSync(path)).toBe(false)
  })
})

describe('diff stats', () => {
  it("matches the full diff's totals, without a git process per untracked file", async () => {
    const repository = temporaryRepository()
    writeFileSync(join(repository, 'keep.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(repository, 'gone.txt'), 'bye\n')
    writeFileSync(join(repository, 'moved.txt'), 'a\nb\nc\nd\ne\nf\ng\nh\n')
    runGit(['add', '.'], repository)
    runGit(['commit', '-m', 'Base files'], repository)
    const checkout = open(repository, 'TASK-0070')
    const { path } = ensureWorktree(checkout.checkout)

    // committed: modified, deleted, renamed, binary
    writeFileSync(join(path, 'keep.txt'), 'one\n2\nthree\nfour\n')
    runGit(['rm', '-q', 'gone.txt'], path)
    runGit(['mv', 'moved.txt', 'renamed.txt'], path)
    writeFileSync(join(path, 'image.bin'), Buffer.from([0, 1, 2, 0, 3]))
    runGit(['add', '.'], path)
    runGit(['commit', '-m', 'Work'], path)
    // uncommitted and untracked: text, no trailing newline, empty, binary, symlink, nested
    writeFileSync(join(path, 'keep.txt'), 'one\n2\nthree\nfour\nfive\n')
    writeFileSync(join(path, 'new.txt'), 'x\ny\n')
    writeFileSync(join(path, 'tail.txt'), 'p\nq')
    writeFileSync(join(path, 'empty.txt'), '')
    writeFileSync(join(path, 'blob.dat'), Buffer.from([65, 0, 66, 10]))
    symlinkSync('new.txt', join(path, 'link.txt'))
    mkdirSync(join(path, 'deep', 'er'), { recursive: true })
    writeFileSync(join(path, 'deep', 'er', 'file.ts'), 'export {}\n')

    const diff = checkout.diff()
    if ('error' in diff) throw new Error(diff.error)
    expect(diff.kind).toBe('changes')
    asyncGit.length = 0
    const stat = await checkout.diffStat()
    expect(stat).toEqual({
      added: diff.totalAdditions,
      removed: diff.totalDeletions,
      files: diff.totalFiles
    })
    expect(asyncGit.length).toBeGreaterThan(0)
    expect(asyncGit.some((args) => args.includes('--no-index'))).toBe(false)
  })

  it('has no totals for a task without changes, or without a worktree', async () => {
    const repository = temporaryRepository()
    const checkout = open(repository, 'TASK-0071')
    expect(await checkout.diffStat()).toBeUndefined()
    ensureWorktree(checkout.checkout)
    expect(await checkout.diffStat()).toBeUndefined()
  })
})

describe('checkoutsOf', () => {
  const base = { id: 'TASK-0001', repoPath: '/work/api', baseBranch: 'main', useWorktree: true }

  it('is the primary alone for a single-repo task', () => {
    const repos = checkoutsOf(DEFAULT_WORKSPACE_ID, base)
    expect(repos.map((repo) => [repo.role, repo.repoName])).toEqual([['primary', 'api']])
    expect(repos[0]?.checkout).toEqual(checkoutOf(DEFAULT_WORKSPACE_ID, base, '/work/api'))
  })

  it('lists the extras after the primary, each with its own base and the same key', () => {
    const repos = checkoutsOf(DEFAULT_WORKSPACE_ID, {
      ...base,
      extraRepos: [{ repoPath: '/work/client', baseBranch: 'release/2.x' }]
    })
    expect(repos.map((repo) => repo.role)).toEqual(['primary', 'extra'])
    expect(repos[1]?.checkout.baseBranch).toBe('release/2.x')
    expect(repos[1]?.checkout.key).toBe(repos[0]?.checkout.key)
    expect(repos[1]?.checkout.repoPath).toBe('/work/client')
  })

  it('ignores extras without a worktree, and ignores a worktreePath that is not derivable', () => {
    expect(
      checkoutsOf(DEFAULT_WORKSPACE_ID, {
        ...base,
        useWorktree: false,
        extraRepos: [{ repoPath: '/work/client' }]
      })
    ).toHaveLength(1)
    const [, extra] = checkoutsOf(DEFAULT_WORKSPACE_ID, {
      ...base,
      extraRepos: [{ repoPath: '/work/client', worktreePath: '/elsewhere' }]
    })
    expect(extra?.checkout.location).toBe('beside')
  })

  it('names two repositories with one folder name by their parent', () => {
    const repos = checkoutsOf(DEFAULT_WORKSPACE_ID, {
      ...base,
      repoPath: '/a/app',
      extraRepos: [{ repoPath: '/b/app' }]
    })
    expect(repos.map((repo) => repo.repoName)).toEqual(['a/app', 'b/app'])
  })

  it('lets taskCheckout list every repository and keep the primary as itself', () => {
    const task = taskCheckout(DEFAULT_WORKSPACE_ID, {
      ...base,
      extraRepos: [{ repoPath: '/work/client' }]
    })
    expect(task.repos).toHaveLength(2)
    expect(task.checkout).toBe(task.repos[0]?.checkout)
  })
})

describe('a multi-repo task in real repositories', () => {
  function change(worktree: string, file: string): void {
    writeFileSync(join(worktree, file), 'work\n')
    runGit(['add', file], worktree)
    runGit(['commit', '-m', `Add ${file}`], worktree)
  }

  it('diffs, patches and measures each repository on its own', async () => {
    const api = temporaryRepository()
    const client = temporaryRepository()
    const task = {
      id: 'TASK-0007',
      repoPath: api,
      useWorktree: true,
      extraRepos: [{ repoPath: client }]
    }
    const opened = taskCheckout(DEFAULT_WORKSPACE_ID, task)
    const [primary, extra] = opened.repos
    if (!primary || !extra) throw new Error('expected two repositories')
    const apiTree = ensureWorktree(primary.checkout).path
    const clientTree = ensureWorktree(extra.checkout).path
    change(apiTree, 'api.txt')
    change(clientTree, 'client-a.txt')
    change(clientTree, 'client-b.txt')

    const launched = taskCheckout(DEFAULT_WORKSPACE_ID, {
      ...task,
      worktreePath: apiTree,
      extraRepos: [{ repoPath: client, worktreePath: clientTree }]
    })
    const files = (repo: number): string[] => {
      const diff = launched.repos[repo]?.diff()
      return diff && 'files' in diff ? diff.files.map((file) => file.path).sort() : []
    }
    expect(files(0)).toEqual(['api.txt'])
    expect(files(1)).toEqual(['client-a.txt', 'client-b.txt'])
    expect(launched.repos[1]?.filePatch('client-a.txt')).toMatchObject({
      patch: expect.stringContaining('+work')
    })
    // A file of the other repository is not in this repository's diff: no arbitrary reads.
    expect(launched.repos[0]?.filePatch('client-a.txt')).not.toHaveProperty('patch')
    expect(await launched.repos[1]?.diffStat()).toMatchObject({ files: 2 })
  })

  it('measures an extra that fell back to the plain repository as the repository itself', () => {
    const api = temporaryRepository()
    const client = temporaryRepository()
    writeFileSync(join(client, 'loose.txt'), 'edit\n')
    const launched = taskCheckout(DEFAULT_WORKSPACE_ID, {
      id: 'TASK-0008',
      repoPath: api,
      useWorktree: true,
      worktreePath: ensureWorktree(
        taskCheckout(DEFAULT_WORKSPACE_ID, { id: 'TASK-0008', repoPath: api }).checkout
      ).path,
      extraRepos: [{ repoPath: client }]
    })
    const diff = launched.repos[1]?.diff()
    expect(diff).toMatchObject({ kind: 'repo' })
  })
})
