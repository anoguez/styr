import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { MAX_PATCH_BYTES } from './diff.js'
import { WORKTREE_BRANCH_PREFIX } from './types.js'

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
 * bare task id) and the base branch the task chose, if any. The worktree path and branch name
 * derive from it, so no caller can pair a key with the wrong repository or base.
 */
export interface Checkout {
  repoPath: string
  key: string
  baseBranch?: string
}

/**
 * Worktrees live beside the repository rather than inside it, so they never show up as untracked
 * files and need no .gitignore entry in the user's project.
 */
export function checkoutPath({ repoPath, key }: Checkout): string {
  return join(dirname(repoPath), `${basename(repoPath)}.worktrees`, key)
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
