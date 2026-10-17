import { addNote, updateTask } from '@core/taskStore.js'
import { loadSettings } from '@core/settingsStore.js'
import {
  LandingCache,
  RemoteFetcher,
  reposAwaitingLanding,
  settleTasks,
  type LandingWrite
} from '@core/landing.js'
import { checkoutGit, type CheckoutGit } from '@core/taskCheckout.js'
import { fetchOrigin } from '@core/worktree.js'
import type { Settings, Task, TaskPatch } from '@core/types.js'

/** The task files, git and the clock a landing pass runs over. */
export interface LandingStore {
  loadSettings(): Settings
  updateTask(id: string, patch: TaskPatch): unknown
  addNote(id: string, author: string, message: string): unknown
  git: CheckoutGit
  /** Updates a repository's `origin` refs. */
  fetchOrigin(repoPath: string): Promise<void>
  /** A repository's fetch failed; reported once per repository per session. */
  warn(message: string, error: unknown): void
  now(): number
}

export const diskLandingStore: LandingStore = {
  loadSettings: () => loadSettings(),
  updateTask,
  addNote,
  git: checkoutGit,
  fetchOrigin,
  warn: (message, error) => console.warn(message, error),
  now: () => Date.now()
}

export interface LandingPorts extends LandingStore {
  /** The active board, from the index. */
  query(): Task[]
}

/**
 * "Done means landed": the landing rules (`core/landing.ts`) run over the active workspace's tasks,
 * and the task-file writes they return. The cache and the fetcher live as long as the landing does,
 * which is what keeps a write from re-running git for every task.
 */
export function createLanding(ports: LandingPorts) {
  const cache = new LandingCache()

  const fetcher = new RemoteFetcher({
    fetch: (repo) => ports.fetchOrigin(repo),
    warn: (repo, error) =>
      ports.warn(
        `landing: could not fetch origin in ${repo}; merged PRs there show once it can:`,
        error instanceof Error ? error.message : error
      ),
    now: () => ports.now()
  })

  /**
   * Runs the landing rules over the active workspace's tasks and performs the task-file writes they
   * return. Returns true when it wrote a task file, so the caller re-indexes. A task whose check
   * failed is logged and retried on the next pass; it never breaks a refresh. `repos` limits the
   * pass to those repositories, the ones a fetch just updated.
   */
  function settleLandedTasks(repos?: ReadonlySet<string>): boolean {
    const settings = ports.loadSettings()
    const tasks = ports.query()
    const { writes, errors } = settleTasks(
      repos ? tasks.filter((task) => task.repoPath && repos.has(task.repoPath)) : tasks,
      {
        git: ports.git,
        cache,
        workspaceId: settings.activeWorkspaceId,
        worktreeLocation: settings.worktreeLocation
      }
    )
    for (const { taskId, error } of errors) {
      ports.warn(`landing: could not settle ${taskId}:`, error)
    }
    for (const write of writes) perform(write)
    return writes.length > 0
  }

  /**
   * Fetches `origin` for every repository with an In Review worktree task (throttled and coalesced
   * by `RemoteFetcher`), then runs the landing rules over the repositories it fetched. Asynchronous
   * and never part of `notifyTasksChanged`; resolves true when it wrote a task file, so the caller
   * re-indexes. Never rejects: offline or without a remote it simply finds nothing.
   */
  async function fetchAndSettle(): Promise<boolean> {
    const fetched = await fetcher.refresh(reposAwaitingLanding(ports.query()))
    return fetched.length > 0 && settleLandedTasks(new Set(fetched))
  }

  function perform(write: LandingWrite): void {
    switch (write.kind) {
      case 'status':
        ports.updateTask(write.taskId, { status: write.status })
        break
      case 'clearWorktree':
        ports.updateTask(write.taskId, { worktreePath: undefined })
        break
      case 'note':
        ports.addNote(write.taskId, 'styr', write.message)
        break
    }
  }

  return { settleLandedTasks, fetchAndSettle }
}

/**
 * Fetches `origin` where In Review work waits to land, then settles what landed — how a PR merged
 * on the host is noticed. Event-driven only (window focus, a Dispatch run, an Auto-run pass, the
 * palette), throttled and coalesced per repository, and never part of `notifyTasksChanged`.
 */
export function mergedWorkCheck(ports: {
  fetchAndSettle(): Promise<boolean>
  notifyTasks(): void
}): () => Promise<void> {
  return async () => {
    try {
      if (await ports.fetchAndSettle()) ports.notifyTasks()
    } catch (error) {
      console.warn('landing: checking for merged work failed:', error)
    }
  }
}
