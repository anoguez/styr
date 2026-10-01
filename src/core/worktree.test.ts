import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  branchNameFor,
  ensureWorktree,
  isGitRepo,
  readGitBranch,
  worktreePathFor
} from './worktree.js'

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
  it('creates a task branch beside the repository and reuses it on resume', () => {
    const repository = temporaryRepository()
    const taskId = 'TASK-0042'
    const expectedPath = worktreePathFor(repository, taskId)

    const created = ensureWorktree(repository, taskId)
    const resumed = ensureWorktree(repository, taskId)

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

    expect(() => ensureWorktree(directory, 'TASK-0043')).toThrow(
      `${directory} is not a git repository`
    )
  })
})
