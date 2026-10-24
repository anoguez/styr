import { resolve } from 'node:path'
import type { DiffResult, DiffStat, PatchResult } from './diff.js'
import { checkoutPath, removeWorktree, type Checkout } from './worktree.js'
import { taskDiff, taskDiffStat, taskFilePatch } from './worktreeDiff.js'
import {
  branchLanding,
  landingGitAsync,
  type CleanupResult,
  type Landing
} from './worktreeLanding.js'
import { repoDisplayNames } from './repoNames.js'
import { worktreeKey, type ExtraRepo, type Task, type WorktreeLocation } from './types.js'

export type { Checkout, CleanupResult, Landing }

const WORKTREE_LOCATIONS: readonly WorktreeLocation[] = ['beside', 'inside']

/**
 * The one place a task becomes a `Checkout`: the key is `worktreeKey(workspaceId, task.id)`, since
 * `TASK-0001` exists in every workspace, and the task's own base branch rides along. A task whose
 * worktree already exists keeps it where it was made, whatever the workspace setting says now;
 * `location` (the workspace's `worktreeLocation`) places only a worktree yet to be created.
 * `worktreePath` is matched against the derivable paths, never trusted as a path of its own.
 */
export function checkoutOf(
  workspaceId: string,
  task: Pick<Task, 'id' | 'baseBranch'> & Partial<Pick<Task, 'worktreePath'>>,
  repoPath: string,
  location: WorktreeLocation = 'beside'
): Checkout {
  const key = worktreeKey(workspaceId, task.id)
  const made = WORKTREE_LOCATIONS.find(
    (candidate) =>
      task.worktreePath !== undefined &&
      samePath(task.worktreePath, checkoutPath({ repoPath, key, location: candidate }))
  )
  return { repoPath, key, baseBranch: task.baseBranch, location: made ?? location }
}

/** One repository of a task: the primary (where the agent starts) or an extra. */
export interface TaskRepoCheckout {
  role: 'primary' | 'extra'
  /** Display name: the folder, or `parent/folder` when two repositories share one. */
  repoName: string
  checkout: Checkout
}

/**
 * Every repository of a task, the primary first, each keyed like `checkoutOf` does: all share the
 * task's branch name (same `worktreeKey`), each in its own repository, with its own base branch.
 * A task without `useWorktree` has no extras — `extraRepos` is ignored then.
 */
export function checkoutsOf(
  workspaceId: string,
  task: Pick<Task, 'id' | 'baseBranch'> &
    Partial<Pick<Task, 'worktreePath' | 'useWorktree'>> & {
      repoPath: string
      extraRepos?: readonly ExtraRepo[]
    },
  location: WorktreeLocation = 'beside'
): TaskRepoCheckout[] {
  const extras: readonly ExtraRepo[] = task.useWorktree === false ? [] : (task.extraRepos ?? [])
  const names = repoDisplayNames([task.repoPath, ...extras.map((extra) => extra.repoPath)])
  return [
    {
      role: 'primary',
      repoName: names[0] as string,
      checkout: checkoutOf(workspaceId, task, task.repoPath, location)
    },
    ...extras.map((extra, index): TaskRepoCheckout => ({
      role: 'extra',
      repoName: names[index + 1] as string,
      checkout: checkoutOf(workspaceId, { ...extra, id: task.id }, extra.repoPath, location)
    }))
  ]
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b)
}

/** The task fields a checkout is derived from; only tasks with a repository have one. */
export type CheckoutTask = Pick<Task, 'id' | 'baseBranch'> &
  Partial<Pick<Task, 'useWorktree' | 'worktreePath' | 'extraRepos'>> & { repoPath: string }

/**
 * One repository of a task, keyed by the task: what it changed, one file's patch, whether its
 * branch has landed, and removing its worktree. The worktree/repository split is decided here — a
 * task with `useWorktree: false` is measured in the repository itself; an unset flag (older task
 * files) counts as a worktree task.
 */
export interface RepoCheckout extends TaskRepoCheckout {
  diff(): DiffResult
  /** The card's totals for a `changes` diff, else undefined. Asynchronous: git off the main thread. */
  diffStat(): Promise<DiffStat | undefined>
  /** `path` must be in the current diff — no arbitrary reads. `full` returns the whole file as context. */
  filePatch(path: string, full?: boolean): PatchResult
  /** Undefined when there is no task branch or no base to compare with. */
  landing(): Landing | undefined
  /** Removes the worktree directory from disk; the task file is updated by the caller. */
  removeWorktree(): void
}

/**
 * A task's checkout is its primary repository's, so single-repo callers need no change; `repos`
 * lists every repository of the task, the primary first (one entry for a single-repo task).
 */
export interface TaskCheckout extends RepoCheckout {
  readonly repos: readonly RepoCheckout[]
}

function repoCheckout(entry: TaskRepoCheckout, worktree: boolean): RepoCheckout {
  const { checkout } = entry
  return {
    ...entry,
    diff: () => taskDiff(checkout, worktree),
    diffStat: () => taskDiffStat(checkout, worktree),
    filePatch: (path, full = false) => taskFilePatch(checkout, worktree, path, full),
    landing: () => branchLanding(checkout),
    removeWorktree: () => removeWorktree(checkout)
  }
}

export function taskCheckout(
  workspaceId: string,
  task: CheckoutTask,
  location?: WorktreeLocation
): TaskCheckout {
  const worktree = task.useWorktree !== false
  const repos = checkoutsOf(workspaceId, task, location).map((entry) =>
    repoCheckout(entry, worktree)
  )
  return { ...(repos[0] as RepoCheckout), repos }
}

/**
 * The git a landing pass runs: one ref listing per repository, then a landing check and a cleanup
 * per checkout. Asynchronous — child processes the main thread does not wait on, one repository's
 * calls in order — because a pass can measure a dozen branches and delete a whole worktree.
 * `checkoutGit` is real git; `landing.test.ts` fakes it to test the rules alone.
 */
export interface CheckoutGit {
  /** Every local and origin ref with its tip, in one git call. Undefined when git cannot list them. */
  refListing(repoPath: string): Promise<string | undefined>
  branchLanding(checkout: Checkout): Promise<Landing | undefined>
  /**
   * Removes a landed task's worktree and branches; each refusal is a note, never a throw. `landing`
   * is the check the caller already ran for this checkout, so it is not run again.
   */
  cleanupLandedTask(checkout: Checkout, landing?: Landing): Promise<CleanupResult>
}

export const checkoutGit: CheckoutGit = landingGitAsync
