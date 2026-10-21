import { existsSync } from 'node:fs'
import {
  baseBranchSteps,
  branchExistsSteps,
  branchNameFor,
  checkoutPath,
  firstLine,
  gitPipeStep,
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
  /**
   * Every commit is on the base, or (squash/rebase merges) every file it changed matches the base,
   * or one commit on the base carries the branch's whole change.
   */
  landed: boolean
  /** The branch commit this answer describes; cleanup deletes the branch only while it is still here. */
  tip?: string
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

/** Squash merges older than the branch tip by more than this are not searched for (clock skew). */
const SQUASH_SEARCH_SLACK_S = 24 * 60 * 60
/** Generous: a big squash merge's patch, which a search must read whole. */
const SQUASH_LOG_MAX_BUFFER = 64 * 1024 * 1024
const SQUASH_ANSWERS_MAX = 1000
const squashAnswers = new Map<string, boolean>()

/**
 * True when one commit on `base` carries the branch's whole change: a squash merge. Unlike
 * `contentLanded` it still holds after the base changes those files again (a badge refresh, a later
 * fix). Patch ids ignore line numbers, so the base may also have moved elsewhere in the same files.
 * Only commits on the base since the merge-base, no older than the tip, and touching the branch's
 * files are read, and answers are kept by commit ids, so a pass after the first costs one rev-parse.
 */
function* squashLanded(repoPath: string, base: string, branch: string): GitSteps<boolean> {
  try {
    const key = [repoPath, yield* gitStep(['rev-parse', `${base}^{commit}`], repoPath), branch]
    const known = squashAnswers.get(key.join('\0'))
    if (known !== undefined) return known
    const answer = yield* searchSquash(repoPath, base, branch)
    if (squashAnswers.size >= SQUASH_ANSWERS_MAX) squashAnswers.clear()
    squashAnswers.set(key.join('\0'), answer)
    return answer
  } catch {
    return false
  }
}

function* searchSquash(repoPath: string, base: string, branch: string): GitSteps<boolean> {
  const mergeBase = yield* gitStep(['merge-base', base, branch], repoPath)
  const changed = (yield* gitStep(['diff', '--name-only', '-z', mergeBase, branch], repoPath))
    .split('\0')
    .filter(Boolean)
  if (changed.length === 0) return false
  const maxBuffer = SQUASH_LOG_MAX_BUFFER
  const diffFlags = ['--no-color', '--no-ext-diff', '--no-textconv']
  const patchIds = function* (patch: string): GitSteps<string[]> {
    const ids = yield* gitPipeStep(['patch-id', '--stable'], repoPath, { input: patch, maxBuffer })
    return ids
      .split('\n')
      .map((line) => line.split(' ')[0] ?? '')
      .filter(Boolean)
  }
  const ownPatch = yield* gitPipeStep(['diff', ...diffFlags, mergeBase, branch], repoPath, {
    maxBuffer
  })
  const [own] = yield* patchIds(ownPatch)
  if (!own) return false
  const tipTime = Number(yield* gitStep(['log', '-1', '--format=%ct', branch], repoPath))
  const since = new Date((tipTime - SQUASH_SEARCH_SLACK_S) * 1000).toISOString()
  const onBase = yield* gitPipeStep(
    [
      'log',
      '-p',
      '--no-merges',
      // whole commits: a diff cut to these paths loses renames, and with them the patch id
      '--full-diff',
      ...diffFlags,
      '--format=commit %H',
      `--since=${since}`,
      `${mergeBase}..${base}`,
      '--',
      ...changed
    ],
    repoPath,
    { maxBuffer }
  )
  return onBase !== '' && (yield* patchIds(onBase)).includes(own)
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
  // The costliest check, so only once the others have failed.
  for (const ref of bases) {
    if (landed || ahead === 0) break
    landed = yield* squashLanded(repoPath, ref, tip)
  }
  if (landed && ahead === 0 && !(yield* hasOwnCommits(repoPath, branch, tip))) landed = false
  // The branch moved while it was being measured: whatever was decided describes a state that no
  // longer exists, so say "not landed" and let the next pass look again.
  if (landed && (yield* branchTip(repoPath, branch)) !== tip) landed = false
  return { branch, base, ahead, landed, tip }
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
  // The branch is deleted only while it is at the commit that was measured, so a commit made since
  // (an agent still at work) keeps it.
  const tip = landing?.tip ?? (yield* branchTip(repoPath, branch))

  // A branch with no commits of its own is not "landed" (that would close an In Review task with
  // no work), but a Done task holds nothing on it to lose, so it is cleaned up like landed work.
  if (landing && !landing.landed && landing.ahead > 0) {
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
    if (!tip) throw new Error('its tip could not be read')
    // `branch -D` without the race: update-ref deletes only if the ref still holds `tip`.
    yield* gitStep(['update-ref', '-d', `refs/heads/${branch}`, tip], repoPath)
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
