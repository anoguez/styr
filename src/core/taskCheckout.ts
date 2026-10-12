import { resolve } from 'node:path'
import type { DiffResult, PatchResult } from './diff.js'
import { checkoutPath, removeWorktree, type Checkout } from './worktree.js'
import { taskDiff, taskFilePatch } from './worktreeDiff.js'
import {
  branchLanding,
  cleanupLandedTask,
  refListing,
  type CleanupResult,
  type Landing
} from './worktreeLanding.js'
import { worktreeKey, type Task, type WorktreeLocation } from './types.js'

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

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b)
}

/** The task fields a checkout is derived from; only tasks with a repository have one. */
export type CheckoutTask = Pick<Task, 'id' | 'baseBranch'> &
  Partial<Pick<Task, 'useWorktree' | 'worktreePath'>> & { repoPath: string }

/**
 * A task's checkout, keyed by the task: what it changed, one file's patch, whether its branch has
 * landed, and removing its worktree. The worktree/repository split is decided here — a task with
 * `useWorktree: false` is measured in the repository itself; an unset flag (older task files)
 * counts as a worktree task.
 */
export interface TaskCheckout {
  readonly checkout: Checkout
  diff(): DiffResult
  /** `path` must be in the current diff — no arbitrary reads. `full` returns the whole file as context. */
  filePatch(path: string, full?: boolean): PatchResult
  /** Undefined when there is no task branch or no base to compare with. */
  landing(): Landing | undefined
  /** Removes the worktree directory from disk; the task file is updated by the caller. */
  removeWorktree(): void
}

export function taskCheckout(
  workspaceId: string,
  task: CheckoutTask,
  location?: WorktreeLocation
): TaskCheckout {
  const checkout = checkoutOf(workspaceId, task, task.repoPath, location)
  const worktree = task.useWorktree !== false
  return {
    checkout,
    diff: () => taskDiff(checkout, worktree),
    filePatch: (path, full = false) => taskFilePatch(checkout, worktree, path, full),
    landing: () => checkoutGit.branchLanding(checkout),
    removeWorktree: () => removeWorktree(checkout)
  }
}

/**
 * The git a landing pass runs: one ref listing per repository, then a landing check and a cleanup
 * per checkout. `checkoutGit` is real git; `landing.test.ts` fakes it to test the rules alone.
 */
export interface CheckoutGit {
  /** Every local and origin ref with its tip, in one git call. Undefined when git cannot list them. */
  refListing(repoPath: string): string | undefined
  branchLanding(checkout: Checkout): Landing | undefined
  /** Removes a landed task's worktree and branches; each refusal is a note, never a throw. */
  cleanupLandedTask(checkout: Checkout): CleanupResult
}

export const checkoutGit: CheckoutGit = { refListing, branchLanding, cleanupLandedTask }
