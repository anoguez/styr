import { addNote, updateTask } from '@core/taskStore.js'
import { loadSettings } from '@core/settingsStore.js'
import {
  LandingCache,
  RemoteFetcher,
  reposAwaitingLanding,
  settleTasks,
  type LandingWrite
} from '@core/landing.js'
import { checkoutGit } from '@core/taskCheckout.js'
import { fetchOrigin } from '@core/worktree.js'
import { queryTasks } from './taskIndex.js'

const cache = new LandingCache()

const fetcher = new RemoteFetcher({
  fetch: fetchOrigin,
  warn: (repo, error) =>
    console.warn(
      `landing: could not fetch origin in ${repo}; merged PRs there show once it can:`,
      error instanceof Error ? error.message : error
    ),
  now: () => Date.now()
})

/**
 * Runs the landing rules over the active workspace's tasks and performs the task-file writes they
 * return (the decisions live in `core/landing.ts`). Returns true when it wrote a task file, so the
 * caller re-indexes. A task whose check failed is logged and retried on the next pass; it never
 * breaks a refresh. `repos` limits the pass to those repositories, the ones a fetch just updated.
 */
export function settleLandedTasks(repos?: ReadonlySet<string>): boolean {
  const settings = loadSettings()
  const tasks = queryTasks()
  const { writes, errors } = settleTasks(
    repos ? tasks.filter((task) => task.repoPath && repos.has(task.repoPath)) : tasks,
    {
      git: checkoutGit,
      cache,
      workspaceId: settings.activeWorkspaceId,
      worktreeLocation: settings.worktreeLocation
    }
  )
  for (const { taskId, error } of errors) {
    console.warn(`landing: could not settle ${taskId}:`, error)
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
export async function fetchAndSettle(): Promise<boolean> {
  const fetched = await fetcher.refresh(reposAwaitingLanding(queryTasks()))
  return fetched.length > 0 && settleLandedTasks(new Set(fetched))
}

function perform(write: LandingWrite): void {
  switch (write.kind) {
    case 'status':
      updateTask(write.taskId, { status: write.status })
      break
    case 'clearWorktree':
      updateTask(write.taskId, { worktreePath: undefined })
      break
    case 'note':
      addNote(write.taskId, 'styr', write.message)
      break
  }
}
