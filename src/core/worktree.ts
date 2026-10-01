import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { WORKTREE_BRANCH_PREFIX } from './types.js'

export interface WorktreeResult {
  path: string
  branch: string
  created: boolean
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

export function isGitRepo(dir: string): boolean {
  if (!dir || !existsSync(dir)) return false
  try {
    return git(['rev-parse', '--is-inside-work-tree'], dir) === 'true'
  } catch {
    return false
  }
}

/**
 * Worktrees live beside the repository rather than inside it, so they never show up as untracked
 * files and need no .gitignore entry in the user's project.
 */
export function worktreePathFor(repoPath: string, taskId: string): string {
  return join(dirname(repoPath), `${basename(repoPath)}.worktrees`, taskId)
}

export function branchNameFor(taskId: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${taskId}`
}

function branchExists(repoPath: string, branch: string): boolean {
  try {
    git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoPath)
    return true
  } catch {
    return false
  }
}

/**
 * Creates the task's worktree if it is missing, or returns the existing one. Idempotent so a
 * resumed session lands back in the same checkout.
 */
export function ensureWorktree(repoPath: string, taskId: string): WorktreeResult {
  if (!isGitRepo(repoPath)) {
    throw new Error(`${repoPath || '(no working directory)'} is not a git repository`)
  }

  const path = worktreePathFor(repoPath, taskId)
  const branch = branchNameFor(taskId)

  git(['worktree', 'prune'], repoPath)
  if (existsSync(path)) return { path, branch, created: false }

  const args = branchExists(repoPath, branch)
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, 'HEAD']
  git(args, repoPath)
  return { path, branch, created: true }
}

/**
 * The checked-out branch of a working directory, or a short SHA when detached. Reads `.git/HEAD`
 * rather than spawning git, so it is cheap enough to call on every agent refresh. In a worktree
 * `.git` is a file pointing at the real git directory, which is resolved here.
 */
export function readGitBranch(dir: string): string | undefined {
  if (!dir || !existsSync(dir)) return undefined
  try {
    const dotGit = join(dir, '.git')
    let gitDir = dotGit
    if (statSync(dotGit).isFile()) {
      const pointer = readFileSync(dotGit, 'utf8').trim()
      const target = pointer.startsWith('gitdir:') ? pointer.slice('gitdir:'.length).trim() : ''
      if (!target) return undefined
      gitDir = target.startsWith('/') ? target : join(dir, target)
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref: refs/heads/')) return head.slice('ref: refs/heads/'.length)
    return head.slice(0, 7)
  } catch {
    return undefined
  }
}

export function removeWorktree(repoPath: string, taskId: string): void {
  if (!isGitRepo(repoPath)) return
  const path = worktreePathFor(repoPath, taskId)
  if (existsSync(path)) git(['worktree', 'remove', path, '--force'], repoPath)
  git(['worktree', 'prune'], repoPath)
}
