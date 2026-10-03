import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { WORKTREE_BRANCH_PREFIX } from './types.js'

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

export interface WorktreeResult {
  path: string
  branch: string
  created: boolean
}

function git(args: string[], cwd: string, timeout?: number): string {
  const env = { ...process.env }
  for (const key of REPOSITORY_CONTEXT_ENV) delete env[key]

  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
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
    : ['worktree', 'add', '-b', branch, path, startPointFor(repoPath)]
  git(args, repoPath)
  return { path, branch, created: true }
}

/**
 * Where a new task branch starts. The main checkout's HEAD is only as fresh as the user's last
 * pull, so work started from it lands on an old version of the app. Fetch first (best effort —
 * offline must not block a launch), then start from the remote tip of the branch the checkout is
 * on (its upstream, or `origin/<name>`), so `main` and `release/x.y.z` checkouts both advance.
 * The remote tip is used only when HEAD is strictly behind it; if HEAD is ahead or diverged it is
 * kept, as that is the user's own state.
 */
function startPointFor(repoPath: string): string {
  try {
    git(['fetch', '--quiet', 'origin'], repoPath, 30_000)
  } catch {
    return 'HEAD'
  }
  for (const remote of remoteCandidates(repoPath)) {
    if (!refExists(repoPath, remote)) continue
    try {
      git(['merge-base', '--is-ancestor', 'HEAD', remote], repoPath)
      return remote
    } catch {
      return 'HEAD'
    }
  }
  return 'HEAD'
}

function remoteCandidates(repoPath: string): string[] {
  const candidates: string[] = []
  try {
    candidates.push(git(['rev-parse', '--abbrev-ref', '@{upstream}'], repoPath))
  } catch {
    // no upstream configured
  }
  try {
    const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
    if (current && current !== 'HEAD') candidates.push(`origin/${current}`)
  } catch {
    // unborn HEAD
  }
  const base = baseBranchFor(repoPath)
  if (base) candidates.push(`origin/${base}`)
  return candidates
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

export interface Landing {
  branch: string
  /** The branch the work is meant to land on. */
  base: string
  /** Commits on the task branch that are not on the base. */
  ahead: number
  /** Every commit is on the base, or (squash/rebase merges) every file it changed matches the base. */
  landed: boolean
}

function refExists(repoPath: string, ref: string): boolean {
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

function countAhead(repoPath: string, base: string, branch: string): number {
  return Number(git(['rev-list', '--count', `${base}..${branch}`], repoPath))
}

/** True when every file the branch changed since its merge-base is identical on `base`. */
function contentLanded(repoPath: string, base: string, branch: string): boolean {
  try {
    const mergeBase = git(['merge-base', base, branch], repoPath)
    const changed = git(['diff', '--name-only', '-z', mergeBase, branch], repoPath)
      .split('\0')
      .filter(Boolean)
    if (changed.length === 0) return false
    git(['diff', '--quiet', base, branch, '--', ...changed], repoPath)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a task branch's work is on the base. A remote-tracking base counts too, so a PR merged on
 * the host is seen before the user pulls. Undefined when there is no branch or no base to compare.
 */
export function branchLanding(repoPath: string, taskId: string): Landing | undefined {
  if (!isGitRepo(repoPath)) return undefined
  const branch = branchNameFor(taskId)
  if (!branchExists(repoPath, branch)) return undefined
  const base = baseBranchFor(repoPath)
  if (!base) return undefined

  const bases = [base, `origin/${base}`].filter((ref) => refExists(repoPath, ref))
  let ahead = countAhead(repoPath, base, branch)
  let landed = false
  for (const ref of bases) {
    const count = countAhead(repoPath, ref, branch)
    ahead = Math.min(ahead, count)
    if (count === 0 || contentLanded(repoPath, ref, branch)) landed = true
  }
  if (landed && ahead === 0 && !hasOwnCommits(repoPath, branch)) landed = false
  return { branch, base, ahead, landed }
}

/**
 * A fresh branch with no commits is trivially "on the base"; that is not landed work. The reflog
 * remembers the commit the branch was created at, so a tip that never moved is told apart from one
 * that was fast-forward merged. Without a reflog the branch is not assumed to have landed.
 */
function hasOwnCommits(repoPath: string, branch: string): boolean {
  try {
    const entries = git(['reflog', 'show', '--format=%H', `refs/heads/${branch}`], repoPath)
      .split('\n')
      .filter(Boolean)
    return entries.length > 1 && entries[0] !== entries[entries.length - 1]
  } catch {
    return false
  }
}

export interface CleanupResult {
  /** The worktree directory is gone (or never existed), so `worktreePath` can be cleared. */
  worktreeRemoved: boolean
  /** One line per thing done or left in place, for the task's Activity. */
  notes: string[]
}

/**
 * Removes what a landed task left behind: its worktree, its local branch and its remote branch.
 * Nothing is forced past a check — a dirty worktree stays, and a branch whose work cannot be shown
 * to be on the base stays — and each refusal is reported rather than thrown.
 */
export function cleanupLandedTask(repoPath: string, taskId: string): CleanupResult {
  const notes: string[] = []
  const path = worktreePathFor(repoPath, taskId)
  const branch = branchNameFor(taskId)
  const landing = branchLanding(repoPath, taskId)

  if (landing && !landing.landed) {
    notes.push(
      `Kept worktree and branch ${branch}: ${landing.ahead} commit(s) are not on ${landing.base}.`
    )
    return { worktreeRemoved: !existsSync(path), notes }
  }

  git(['worktree', 'prune'], repoPath)
  if (existsSync(path)) {
    try {
      git(['worktree', 'remove', path], repoPath)
      notes.push(`Removed worktree ${path}.`)
    } catch {
      notes.push(`Left worktree ${path} in place: it has uncommitted or untracked changes.`)
      return { worktreeRemoved: false, notes }
    }
  }
  if (!landing) return { worktreeRemoved: true, notes }

  const remoteTip = remoteBranchTip(repoPath, branch)
  const localTip = git(['rev-parse', branch], repoPath)
  try {
    git(['branch', '-D', branch], repoPath)
    notes.push(`Deleted local branch ${branch}.`)
  } catch (error) {
    notes.push(`Could not delete local branch ${branch}: ${firstLine(error)}`)
  }

  if (remoteTip === localTip) {
    try {
      git(['push', 'origin', '--delete', branch], repoPath, 30_000)
      notes.push(`Deleted remote branch origin/${branch}.`)
    } catch (error) {
      notes.push(`Could not delete remote branch origin/${branch}: ${firstLine(error)}`)
    }
  } else if (remoteTip) {
    notes.push(`Kept remote branch origin/${branch}: it has commits that are not the local tip.`)
  }
  return { worktreeRemoved: true, notes }
}

function remoteBranchTip(repoPath: string, branch: string): string | undefined {
  try {
    const line = git(['ls-remote', '--heads', 'origin', branch], repoPath, 15_000)
    return line.split(/\s/)[0] || undefined
  } catch {
    return undefined
  }
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n').find((line) => line.trim() && !line.startsWith('Command failed')) ?? text
}
