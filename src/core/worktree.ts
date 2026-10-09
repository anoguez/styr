import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  branchExists,
  branchNameFor,
  checkoutPath,
  git,
  isGitRepo,
  refExists,
  baseBranchFor,
  type Checkout
} from './gitExec.js'
import { WORKTREE_BRANCH_PREFIX } from './types.js'

export { baseBranchFor, branchNameFor, checkoutPath, isGitRepo }
export type { Checkout }

export interface WorktreeResult {
  path: string
  branch: string
  created: boolean
  /** On creation, the branch the task branch was cut from — what its diff and landing compare with. */
  baseBranch?: string
}

/**
 * Creates the task's worktree if it is missing, or returns the existing one. Idempotent so a
 * resumed session lands back in the same checkout.
 */
export function ensureWorktree(checkout: Checkout): WorktreeResult {
  const { repoPath } = checkout
  if (!isGitRepo(repoPath)) {
    throw new Error(`${repoPath || '(no working directory)'} is not a git repository`)
  }

  const path = checkoutPath(checkout)
  const branch = branchNameFor(checkout.key)

  git(['worktree', 'prune'], repoPath)
  if (existsSync(path)) return { path, branch, created: false }

  if (branchExists(repoPath, branch)) {
    git(['worktree', 'add', path, branch], repoPath)
    return { path, branch, created: true }
  }
  const start = startPointFor(checkout)
  git(['worktree', 'add', '-b', branch, path, start.ref], repoPath)
  return { path, branch, created: true, baseBranch: start.branch }
}

/**
 * Where a new task branch starts. The main checkout's HEAD is only as fresh as the user's last
 * pull, so work started from it lands on an old version of the app. Fetch first (best effort —
 * offline must not block a launch), then start from the remote tip of the branch the checkout is
 * on (its upstream, or `origin/<name>`), so `main` and `release/x.y.z` checkouts both advance.
 * The remote tip is used only when HEAD is strictly behind it; if HEAD is ahead or diverged it is
 * kept, as that is the user's own state. `branch` names the branch that start point stands for.
 */
function startPointFor({ repoPath, baseBranch }: Checkout): { ref: string; branch?: string } {
  let fetched = true
  try {
    git(['fetch', '--quiet', 'origin'], repoPath, 30_000)
  } catch {
    fetched = false
  }
  if (baseBranch) {
    // An explicit choice wins: the fetched remote tip, else the local branch. A branch that has
    // since vanished falls through to the automatic choice rather than failing the launch.
    const remote = `origin/${baseBranch}`
    if (fetched && refExists(repoPath, remote)) return { ref: remote, branch: baseBranch }
    if (refExists(repoPath, baseBranch)) return { ref: baseBranch, branch: baseBranch }
    if (refExists(repoPath, remote)) return { ref: remote, branch: baseBranch }
  }
  const head = { ref: 'HEAD', branch: currentBranch(repoPath) }
  if (!fetched) return head
  for (const remote of remoteCandidates(repoPath)) {
    if (!refExists(repoPath, remote)) continue
    try {
      git(['merge-base', '--is-ancestor', 'HEAD', remote], repoPath)
      return { ref: remote, branch: remote.replace(/^origin\//, '') }
    } catch {
      return head
    }
  }
  return head
}

function currentBranch(repoPath: string): string | undefined {
  try {
    const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
    return current && current !== 'HEAD' ? current : undefined
  } catch {
    return undefined // unborn HEAD
  }
}

function remoteCandidates(repoPath: string): string[] {
  const candidates: string[] = []
  try {
    candidates.push(git(['rev-parse', '--abbrev-ref', '@{upstream}'], repoPath))
  } catch {
    // no upstream configured
  }
  const current = currentBranch(repoPath)
  if (current) candidates.push(`origin/${current}`)
  const base = baseBranchFor(repoPath)
  if (base) candidates.push(`origin/${base}`)
  return candidates
}

/** Branches a worktree can start from: local ones plus origin's, deduplicated, current first. */
export function listBranches(repoPath: string): { branches: string[]; current?: string } {
  if (!isGitRepo(repoPath)) return { branches: [] }
  const names = new Set<string>()
  let current: string | undefined
  try {
    const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
    if (head && head !== 'HEAD') current = head
  } catch {
    // unborn HEAD
  }
  const collect = (ref: string, strip: string): void => {
    try {
      for (const line of git(['for-each-ref', '--format=%(refname:short)', ref], repoPath).split(
        '\n'
      )) {
        const name = line.startsWith(strip) ? line.slice(strip.length) : line
        if (name && name !== 'origin' && name !== 'HEAD') names.add(name)
      }
    } catch {
      // no refs of that kind
    }
  }
  collect('refs/heads', '')
  collect('refs/remotes/origin', 'origin/')
  const branches = [...names].filter((name) => !name.startsWith(WORKTREE_BRANCH_PREFIX)).sort()
  if (current) branches.sort((a, b) => Number(b === current) - Number(a === current))
  return { branches, current }
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

/**
 * The top of the checkout `dir` is inside, found by walking up to the nearest `.git` (a directory,
 * or a pointer file in a linked worktree). Reads the filesystem only, so it is cheap to call.
 */
export function findGitRoot(dir: string): string | undefined {
  let current = dir
  while (current) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}
export function removeWorktree(checkout: Checkout): void {
  const { repoPath } = checkout
  if (!isGitRepo(repoPath)) return
  const path = checkoutPath(checkout)
  if (existsSync(path)) git(['worktree', 'remove', path, '--force'], repoPath)
  git(['worktree', 'prune'], repoPath)
}
