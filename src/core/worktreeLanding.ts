import { existsSync } from 'node:fs'
import {
  baseBranchSteps,
  branchExistsSteps,
  branchNameFor,
  checkoutPath,
  firstLine,
  gitStep,
  isGitRepoSteps,
  refExistsSteps,
  runGitAsync,
  runGitSync,
  type Checkout,
  type GitSteps
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

function* countAhead(repoPath: string, base: string, branch: string): GitSteps<number> {
  return Number(yield* gitStep(['rev-list', '--count', `${base}..${branch}`], repoPath))
}

/** True when every file the branch changed since its merge-base is identical on `base`. */
function* contentLanded(repoPath: string, base: string, branch: string): GitSteps<boolean> {
  try {
    const mergeBase = yield* gitStep(['merge-base', base, branch], repoPath)
    const changed = (yield* gitStep(['diff', '--name-only', '-z', mergeBase, branch], repoPath))
      .split('\0')
      .filter(Boolean)
    if (changed.length === 0) return false
    yield* gitStep(['diff', '--quiet', base, branch, '--', ...changed], repoPath)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a task branch's work is on the base. A remote-tracking base counts too, so a PR merged on
 * the host is seen before the user pulls. Undefined when there is no branch or no base to compare.
 */
export function branchLanding(checkout: Checkout): Landing | undefined {
  return runGitSync(branchLandingSteps(checkout))
}

function* branchLandingSteps({
  repoPath,
  key,
  baseBranch
}: Checkout): GitSteps<Landing | undefined> {
  if (!(yield* isGitRepoSteps(repoPath))) return undefined
  const branch = branchNameFor(key)
  if (!(yield* branchExistsSteps(repoPath, branch))) return undefined
  // The task's own base wins while it still exists; a vanished one falls back to the automatic base.
  const chosen =
    baseBranch &&
    ((yield* refExistsSteps(repoPath, `refs/heads/${baseBranch}`)) ||
      (yield* refExistsSteps(repoPath, `refs/remotes/origin/${baseBranch}`)))
      ? baseBranch
      : undefined
  const base = chosen ?? (yield* baseBranchSteps(repoPath))
  if (!base) return undefined

  const bases: string[] = []
  for (const ref of [base, `origin/${base}`]) {
    if (yield* refExistsSteps(repoPath, ref)) bases.push(ref)
  }
  if (bases.length === 0) return undefined
  // Everything below measures this one commit. The answer is computed from several git calls, and
  // an agent committing in between used to mix "0 ahead" (old tip) with "has own commits" (new
  // tip), which reads as a fast-forward merge and sent unlanded work to Done.
  const tip = yield* branchTip(repoPath, branch)
  if (!tip) return undefined
  let ahead = Infinity
  let landed = false
  for (const ref of bases) {
    const count = yield* countAhead(repoPath, ref, tip)
    ahead = Math.min(ahead, count)
    if (count === 0 || (yield* contentLanded(repoPath, ref, tip))) landed = true
  }
  if (landed && ahead === 0 && !(yield* hasOwnCommits(repoPath, branch, tip))) landed = false
  // The branch moved while it was being measured: whatever was decided describes a state that no
  // longer exists, so say "not landed" and let the next pass look again.
  if (landed && (yield* branchTip(repoPath, branch)) !== tip) landed = false
  return { branch, base, ahead, landed }
}

function* branchTip(repoPath: string, branch: string): GitSteps<string | undefined> {
  try {
    return yield* gitStep(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`],
      repoPath
    )
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
function* hasOwnCommits(repoPath: string, branch: string, tip: string): GitSteps<boolean> {
  try {
    const entries = (yield* gitStep(
      ['reflog', 'show', '--format=%H', `refs/heads/${branch}`],
      repoPath
    ))
      .split('\n')
      .filter(Boolean)
    return entries.length > 1 && entries[0] === tip && entries[0] !== entries[entries.length - 1]
  } catch {
    return false
  }
}

/** Every local and origin ref with its tip, in one git call. Undefined when git cannot list them. */
export function refListing(repoPath: string): string | undefined {
  return runGitSync(refListingSteps(repoPath))
}

function* refListingSteps(repoPath: string): GitSteps<string | undefined> {
  try {
    return yield* gitStep(
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
 * Removes what a landed task left behind on this machine: its worktree and its local branch. Nothing
 * on a remote is ever touched — a remote branch may carry an open PR, and deleting it closes the PR.
 * Nothing is forced past a check — a dirty worktree stays, and a branch whose work cannot be shown
 * to be on the base stays — and each refusal is reported rather than thrown.
 */
export function cleanupLandedTask(checkout: Checkout): CleanupResult {
  return runGitSync(cleanupSteps(checkout))
}

/**
 * `cleanupLandedTask` measured once: `known` is the landing the caller just computed for this
 * checkout, so the check is not run twice. Omitted, it is computed here.
 */
function* cleanupSteps(checkout: Checkout, known?: Landing): GitSteps<CleanupResult> {
  const { repoPath, key } = checkout
  const notes: string[] = []
  const path = checkoutPath(checkout)
  const branch = branchNameFor(key)
  const landing = known ?? (yield* branchLandingSteps(checkout))

  if (landing && !landing.landed) {
    notes.push(
      `Kept worktree and branch ${branch}: ${landing.ahead} commit(s) are not on ${landing.base}. Use Remove in the task dialog to discard the checkout.`
    )
    return { worktreeRemoved: !existsSync(path), notes }
  }

  yield* gitStep(['worktree', 'prune'], repoPath)
  if (existsSync(path)) {
    try {
      yield* gitStep(['worktree', 'remove', path], repoPath)
      notes.push(`Removed worktree ${path}.`)
    } catch {
      notes.push(`Left worktree ${path} in place: it has uncommitted or untracked changes.`)
      return { worktreeRemoved: false, notes }
    }
  }
  if (!landing) return { worktreeRemoved: true, notes }

  try {
    yield* gitStep(['branch', '-D', branch], repoPath)
    notes.push(`Deleted local branch ${branch}.`)
  } catch (error) {
    notes.push(`Could not delete local branch ${branch}: ${firstLine(error)}`)
  }
  return { worktreeRemoved: true, notes }
}

/**
 * The landing pass's git, off the main thread: the same conversations as the synchronous functions
 * above, run in child processes through each repository's queue.
 */
export const landingGitAsync = {
  refListing: (repoPath: string): Promise<string | undefined> =>
    runGitAsync(repoPath, refListingSteps(repoPath)),
  branchLanding: (checkout: Checkout): Promise<Landing | undefined> =>
    runGitAsync(checkout.repoPath, branchLandingSteps(checkout)),
  cleanupLandedTask: (checkout: Checkout, landing?: Landing): Promise<CleanupResult> =>
    runGitAsync(checkout.repoPath, cleanupSteps(checkout, landing))
}
