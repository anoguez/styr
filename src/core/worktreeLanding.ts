import { existsSync } from 'node:fs'
import {
  baseBranchFor,
  branchExists,
  branchNameFor,
  checkoutPath,
  firstLine,
  git,
  isGitRepo,
  refExists,
  type Checkout
} from './gitExec.js'

export interface Landing {
  branch: string
  /** The branch the work is meant to land on. */
  base: string
  /** Commits on the task branch that are not on the base. */
  ahead: number
  /** Every commit is on the base, or (squash/rebase merges) every file it changed matches the base. */
  landed: boolean
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
export function branchLanding({ repoPath, key, baseBranch }: Checkout): Landing | undefined {
  if (!isGitRepo(repoPath)) return undefined
  const branch = branchNameFor(key)
  if (!branchExists(repoPath, branch)) return undefined
  // The task's own base wins while it still exists; a vanished one falls back to the automatic base.
  const chosen =
    baseBranch &&
    (refExists(repoPath, `refs/heads/${baseBranch}`) ||
      refExists(repoPath, `refs/remotes/origin/${baseBranch}`))
      ? baseBranch
      : undefined
  const base = chosen ?? baseBranchFor(repoPath)
  if (!base) return undefined

  const bases = [base, `origin/${base}`].filter((ref) => refExists(repoPath, ref))
  if (bases.length === 0) return undefined
  // Everything below measures this one commit. The answer is computed from several git calls, and
  // an agent committing in between used to mix "0 ahead" (old tip) with "has own commits" (new
  // tip), which reads as a fast-forward merge and sent unlanded work to Done.
  const tip = branchTip(repoPath, branch)
  if (!tip) return undefined
  let ahead = Infinity
  let landed = false
  for (const ref of bases) {
    const count = countAhead(repoPath, ref, tip)
    ahead = Math.min(ahead, count)
    if (count === 0 || contentLanded(repoPath, ref, tip)) landed = true
  }
  if (landed && ahead === 0 && !hasOwnCommits(repoPath, branch, tip)) landed = false
  // The branch moved while it was being measured: whatever was decided describes a state that no
  // longer exists, so say "not landed" and let the next pass look again.
  if (landed && branchTip(repoPath, branch) !== tip) landed = false
  return { branch, base, ahead, landed }
}

function branchTip(repoPath: string, branch: string): string | undefined {
  try {
    return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], repoPath)
  } catch {
    return undefined
  }
}

/**
 * A fresh branch with no commits is trivially "on the base"; that is not landed work. The reflog
 * remembers the commit the branch was created at, so a tip that never moved is told apart from one
 * that was fast-forward merged. Without a reflog the branch is not assumed to have landed. The
 * newest entry must be the tip being measured, or the reflog describes a different state.
 */
function hasOwnCommits(repoPath: string, branch: string, tip: string): boolean {
  try {
    const entries = git(['reflog', 'show', '--format=%H', `refs/heads/${branch}`], repoPath)
      .split('\n')
      .filter(Boolean)
    return entries.length > 1 && entries[0] === tip && entries[0] !== entries[entries.length - 1]
  } catch {
    return false
  }
}

/** Every local and origin ref with its tip, in one git call. Undefined when git cannot list them. */
export function refListing(repoPath: string): string | undefined {
  try {
    return git(
      ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes/origin'],
      repoPath
    )
  } catch {
    return undefined
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
export function cleanupLandedTask(checkout: Checkout): CleanupResult {
  const { repoPath, key } = checkout
  const notes: string[] = []
  const path = checkoutPath(checkout)
  const branch = branchNameFor(key)
  const landing = branchLanding(checkout)

  if (landing && !landing.landed) {
    notes.push(
      `Kept worktree and branch ${branch}: ${landing.ahead} commit(s) are not on ${landing.base}. Use Remove in the task dialog to discard the checkout.`
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
