import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { MAX_PATCH_BYTES } from './diff.js'
import { WORKTREE_BRANCH_PREFIX, type WorktreeLocation } from './types.js'

// Private to the checkout cluster: imported by worktree.ts, worktreeLanding.ts and worktreeDiff.ts only.

const REPOSITORY_CONTEXT_ENV = [
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
 * A task's checkout: the repository, the worktree key (`worktreeKey(workspaceId, taskId)`, not a
 * bare task id), the base branch the task chose, if any, and where its worktree lives. The worktree
 * path and branch name derive from it, so no caller can pair a key with the wrong repository or base.
 */
export interface Checkout {
  repoPath: string
  key: string
  baseBranch?: string
  /** Unset is `beside`, where every worktree lived before the setting existed. */
  location?: WorktreeLocation
}

/**
 * The folder holding a repository's worktrees. `beside` keeps them out of the repository, so they
 * never show up as untracked files; `inside` puts them under `.styr/worktrees`, which
 * `ensureWorktree` hides from git with its own `.gitignore`.
 */
export function worktreesDir(repoPath: string, location: WorktreeLocation = 'beside'): string {
  return location === 'inside'
    ? join(repoPath, '.styr', 'worktrees')
    : join(dirname(repoPath), `${basename(repoPath)}.worktrees`)
}

export function checkoutPath({ repoPath, key, location }: Checkout): string {
  return join(worktreesDir(repoPath, location), key)
}

export function branchNameFor(key: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${key}`
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of REPOSITORY_CONTEXT_ENV) delete env[key]
  return env
}

export function git(args: string[], cwd: string, timeout?: number): string {
  return execFileSync('git', args, {
    cwd,
    env: cleanEnv(),
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

/**
 * `git()` in a child process the caller does not wait on: for slow, network-bound commands that
 * must stay off the main process's thread. It never prompts for credentials — a fetch that would
 * ask fails instead of hanging.
 */
export function gitAsync(args: string[], cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...cleanEnv(), GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', timeout },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))
    )
  })
}

/** Like `git()` but keeps the output intact and returns stdout of a command that may exit 1. */
export function gitRaw(args: string[], cwd: string, okExit: number[] = [0]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      env: cleanEnv(),
      encoding: 'utf8',
      maxBuffer: MAX_PATCH_BYTES * 4,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    const failure = error as { status?: number; stdout?: string }
    if (failure.status !== undefined && okExit.includes(failure.status)) return failure.stdout ?? ''
    throw error
  }
}

export function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n').find((line) => line.trim() && !line.startsWith('Command failed')) ?? text
}

export function isGitRepo(dir: string): boolean {
  if (!dir || !existsSync(dir)) return false
  try {
    return git(['rev-parse', '--is-inside-work-tree'], dir) === 'true'
  } catch {
    return false
  }
}

export function branchExists(repoPath: string, branch: string): boolean {
  try {
    git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoPath)
    return true
  } catch {
    return false
  }
}

export function refExists(repoPath: string, ref: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath)
    return true
  } catch {
    return false
  }
}

/**
 * The branch work is meant to land on: the remote's default branch when there is one, else
 * `main`/`master`, else whatever the main checkout is on (a worktree branches from its HEAD).
 */
export function baseBranchFor(repoPath: string): string | undefined {
  try {
    const remoteHead = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoPath)
    const name = remoteHead.replace(/^origin\//, '')
    if (name && refExists(repoPath, `refs/heads/${name}`)) return name
  } catch {
    // no remote, or origin/HEAD was never set
  }
  for (const name of ['main', 'master']) {
    if (refExists(repoPath, `refs/heads/${name}`)) return name
  }
  try {
    const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
    return current && current !== 'HEAD' ? current : undefined
  } catch {
    return undefined
  }
}
