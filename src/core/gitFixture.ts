import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Throwaway git repositories for the worktree and checkout tests.

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

/**
 * Per-test timeout for tests that drive real git. Spawning git is slow on the Windows runner, and
 * the git-backed test files run in parallel there, so a clone or squash merge can pass vitest's
 * 5s default. Pass it to `vi.setConfig` at the top of the test file.
 */
export const GIT_TEST_TIMEOUT_MS = 30_000

const temporaryDirectories: string[] = []

/** A directory removed by `removeTemporaryDirectories`; call that from the test file's `afterEach`. */
export function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

export function removeTemporaryDirectories(): void {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** A repository on `main` with one commit. */
export function temporaryRepository(): string {
  const repository = temporaryDirectory('styr-worktree-test-')
  runGit(['init', '--initial-branch=main'], repository)
  runGit(['config', 'user.name', 'Styr test'], repository)
  runGit(['config', 'user.email', 'test@example.com'], repository)
  writeFileSync(join(repository, 'README.md'), '# Test repository\n')
  runGit(['add', 'README.md'], repository)
  runGit(['commit', '-m', 'Initial commit'], repository)
  return repository
}

/** Runs git outside any repository the test runner itself was started in (a hook, a worktree). */
export function runGit(args: string[], cwd: string): string {
  const env = { ...process.env }
  for (const key of GIT_REPOSITORY_CONTEXT) delete env[key]
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' })
}
