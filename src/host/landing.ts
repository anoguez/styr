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
  /** One task of the active board as it is now, to tell whether a decision went stale. */
  find(id: string): Task | null | undefined
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

  /** The pass in progress, and the one pass that waits behind it. */
  type Scope = ReadonlySet<string> | 'all'
  interface Queued {
    scope: Scope
    done: Promise<boolean>
  }
  let running: Promise<boolean> | undefined
  let queued: Queued | undefined

  /**
   * Runs the landing rules over the active workspace's tasks and performs the task-file writes they
   * return. Resolves true when it wrote a task file, so the caller re-indexes. A task whose check
   * failed is logged and retried on the next pass; it never breaks a refresh. `repos` limits the
   * pass to those repositories, the ones a fetch just updated.
   *
   * The git runs in child processes, so the main thread stays free while a pass measures branches
   * or deletes a worktree. One pass runs at a time: a request that arrives during a pass joins the
   * single pass queued behind it (their repositories merged), however many arrive. Never rejects.
   */
  function settleLandedTasks(repos?: ReadonlySet<string>): Promise<boolean> {
    const wanted: Scope = repos ? new Set(repos) : 'all'
    if (!running) return start(wanted)
    if (queued) {
      queued.scope = merge(queued.scope, wanted)
      return queued.done
    }
    const entry: Queued = { scope: wanted, done: Promise.resolve(false) }
    entry.done = running.then(() => {
      queued = undefined
      return start(entry.scope)
    })
    queued = entry
    return entry.done
  }

  function merge(a: Scope, b: Scope): Scope {
    return a === 'all' || b === 'all' ? 'all' : new Set([...a, ...b])
  }

  function start(scope: Scope): Promise<boolean> {
    const run: Promise<boolean> = pass(scope)
      .catch((error: unknown) => {
        ports.warn('landing: the pass failed:', error)
        return false
      })
      .finally(() => {
        if (running === run) running = undefined
      })
    running = run
    return run
  }

  async function pass(scope: Scope): Promise<boolean> {
    const settings = ports.loadSettings()
    const workspaceId = settings.activeWorkspaceId
    const tasks = ports
      .query()
      .filter((task) => scope === 'all' || (task.repoPath && scope.has(task.repoPath)))
    const { writes, errors } = await settleTasks(tasks, {
      git: ports.git,
      cache,
      workspaceId,
      worktreeLocation: settings.worktreeLocation
    })
    for (const { taskId, error } of errors) {
      ports.warn(`landing: could not settle ${taskId}:`, error)
    }
    // The board may have moved on while git ran. Writes for a workspace that is no longer active
    // would land in the wrong one; the next pass there looks again.
    if (writes.length === 0 || ports.loadSettings().activeWorkspaceId !== workspaceId) return false
    const measured = new Map(tasks.map((task) => [task.id, task]))
    let wrote = false
    for (const [taskId, taskWrites] of groupByTask(writes)) {
      if (isStale(measured.get(taskId), ports.find(taskId))) {
        // Moved, edited or removed since it was measured: not this pass's call. Not cached, so
        // the next pass measures it again.
        cache.forget(`${workspaceId}:${taskId}`)
        continue
      }
      for (const write of taskWrites) perform(write)
      wrote = true
    }
    return wrote
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

function groupByTask(writes: readonly LandingWrite[]): Map<string, LandingWrite[]> {
  const groups = new Map<string, LandingWrite[]>()
  for (const write of writes) {
    const group = groups.get(write.taskId) ?? []
    group.push(write)
    groups.set(write.taskId, group)
  }
  return groups
}

/** The fields a landing decision rests on changed between measuring and writing. */
function isStale(measured: Task | undefined, now: Task | null | undefined): boolean {
  return (
    !measured ||
    !now ||
    now.status !== measured.status ||
    now.worktreePath !== measured.worktreePath
  )
}

/**
 * What `notifyTasksChanged` calls instead of settling inline: starts a landing pass (or joins the
 * one queued) and returns at once, re-indexing when the pass wrote. Never throws.
 */
export function landingRequests(ports: {
  settleLandedTasks(): Promise<boolean>
  notifyTasks(): void
}): () => void {
  const check = mergedWorkCheck({
    fetchAndSettle: () => ports.settleLandedTasks(),
    notifyTasks: () => ports.notifyTasks()
  })
  return () => void check()
}

/**
 * Fetches `origin` where In Review work waits to land, then settles what landed — how a PR merged
 * on the host is noticed. Re-indexes when that wrote a task file. Event-driven only (window focus, a Dispatch run, an Auto-run pass, the
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
