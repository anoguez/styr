import { z } from 'zod'
import type { DiffResult, DiffStat, PatchResult } from '@core/diff.js'
import { resolve } from 'node:path'
import {
  taskCheckout,
  type CheckoutTask,
  type RepoCheckout,
  type TaskCheckout
} from '@core/taskCheckout.js'
import { findGitRoot, listBranches, readGitBranch } from '@core/worktree.js'
import type { Settings, Task, WorktreeLocation } from '@core/types.js'

/** The git a checkout's views read, from `core/taskCheckout.ts` and `core/worktree.ts`. */
export interface RepoGit {
  checkout(workspaceId: string, task: CheckoutTask, location?: WorktreeLocation): TaskCheckout
  listBranches(repoPath: string): { branches: string[]; current?: string }
  findGitRoot(path: string): string | undefined
  readGitBranch(root: string): string | undefined
}

export const diskRepoGit: RepoGit = {
  checkout: taskCheckout,
  listBranches,
  findGitRoot,
  readGitBranch
}

export interface GitServicePorts {
  loadSettings(): Settings
  /** The active board, from the index. */
  index: { query(): Task[]; find(id: string): Task | null | undefined }
  git: RepoGit
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b)
}

export const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * What the board shows of the tasks' checkouts: a task's diff and one file's patch, the cards'
 * change totals, a repository's branches and a terminal's git context. Errors about the request
 * come back as data, not as a thrown IPC failure.
 */
export function createGitService(ports: GitServicePorts) {
  /** A task's checkout in the active workspace, placed by that workspace's `worktreeLocation`. */
  function checkout(task: CheckoutTask): TaskCheckout {
    const { activeWorkspaceId, worktreeLocation } = ports.loadSettings()
    return ports.git.checkout(activeWorkspaceId, task, worktreeLocation)
  }

  /** Resolves the task a diff request names. */
  function diffTask(taskId: unknown): (Task & { repoPath: string }) | { error: string } {
    const id = z.string().min(1).safeParse(taskId)
    if (!id.success) return { error: 'Invalid task id' }
    const task = ports.index.find(id.data)
    if (!task) return { error: 'Task not found' }
    if (!task.repoPath) return { error: 'This task has no repository' }
    return { ...task, repoPath: task.repoPath }
  }

  /**
   * The repository of a multi-repo task a request names (its `repoPath`), the primary when none is
   * named. Only the task's own repositories resolve: a path that is not one of them is refused, so
   * a diff request cannot read an arbitrary repository.
   */
  function repoOf(task: CheckoutTask, repo: unknown): RepoCheckout | { error: string } {
    const all = checkout(task)
    if (repo === undefined || repo === null) return all
    const wanted = z.string().min(1).safeParse(repo)
    if (!wanted.success) return { error: 'Invalid repository' }
    const found = all.repos.find((candidate) => samePath(candidate.checkout.repoPath, wanted.data))
    return found ?? { error: 'That repository is not part of this task' }
  }

  function taskDiff(taskId: unknown, repo?: unknown): DiffResult {
    const task = diffTask(taskId)
    if ('error' in task) return task
    const target = repoOf(task, repo)
    return 'error' in target ? target : target.diff()
  }

  function filePatch(taskId: unknown, path: unknown, full?: unknown, repo?: unknown): PatchResult {
    const task = diffTask(taskId)
    if ('error' in task) return task
    const file = z.string().min(1).safeParse(path)
    if (!file.success) return { error: 'Invalid path' }
    const target = repoOf(task, repo)
    return 'error' in target ? target : target.filePatch(file.data, full === true)
  }

  /**
   * Per-task change totals for the cards. The git runs in child processes, so IPC, the watcher and
   * the terminals are served the whole time.
   */
  async function computeDiffStats(): Promise<Record<string, DiffStat>> {
    const { activeWorkspaceId: workspaceId, worktreeLocation } = ports.loadSettings()
    const stats: Record<string, DiffStat> = {}
    for (const task of ports.index.query()) {
      // Done work has landed (or is being cleaned up); a count there is noise.
      const { repoPath } = task
      const launched = Boolean(task.worktreePath) || task.extraRepos.some((e) => e.worktreePath)
      if (!launched || !repoPath || task.status === 'done' || task.archivedAt) continue
      const { repos } = ports.git.checkout(workspaceId, { ...task, repoPath }, worktreeLocation)
      if (repos.length === 1) {
        const stat = await (repos[0] as RepoCheckout).diffStat()
        if (stat) stats[task.id] = stat
        continue
      }
      // A multi-repo task: the card shows the sum, and the tooltip each repository.
      const parts: NonNullable<DiffStat['repos']> = []
      for (const repo of repos) {
        const stat = await repo.diffStat()
        if (stat) parts.push({ name: repo.repoName, ...stat })
      }
      if (parts.length > 0) {
        stats[task.id] = {
          added: parts.reduce((sum, part) => sum + part.added, 0),
          removed: parts.reduce((sum, part) => sum + part.removed, 0),
          files: parts.reduce((sum, part) => sum + part.files, 0),
          repos: parts
        }
      }
    }
    return stats
  }

  let diffStatsRun: Promise<Record<string, DiffStat>> | undefined

  /** One run at a time: a burst of task changes must not stack up a queue of full git passes. */
  function diffStats(): Promise<Record<string, DiffStat>> {
    diffStatsRun ??= computeDiffStats().finally(() => {
      diffStatsRun = undefined
    })
    return diffStatsRun
  }

  function gitContext(path: string): { root: string | null; branch: string | null } {
    const root = ports.git.findGitRoot(path)
    return { root: root ?? null, branch: (root && ports.git.readGitBranch(root)) ?? null }
  }

  return {
    checkout,
    taskDiff,
    filePatch,
    diffStats,
    branches: (repoPath: string) => ports.git.listBranches(repoPath),
    gitContext
  }
}

export type GitService = ReturnType<typeof createGitService>
