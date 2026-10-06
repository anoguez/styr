import { addNote, updateTask } from '@core/taskStore.js'
import { loadSettings } from '@core/settingsStore.js'
import { LandingCache, settleTasks, type LandingWrite } from '@core/landing.js'
import { branchLanding, cleanupLandedTask, refListing } from '@core/worktreeLanding.js'
import { queryTasks } from './taskIndex.js'

const cache = new LandingCache()

/**
 * Runs the landing rules over the active workspace's tasks and performs the task-file writes they
 * return (the decisions live in `core/landing.ts`). Returns true when it wrote a task file, so the
 * caller re-indexes. A task whose check failed is logged and retried on the next pass; it never
 * breaks a refresh.
 */
export function settleLandedTasks(): boolean {
  const { writes, errors } = settleTasks(queryTasks(), {
    git: { refListing, branchLanding, cleanupLandedTask },
    cache,
    workspaceId: loadSettings().activeWorkspaceId
  })
  for (const { taskId, error } of errors) {
    console.warn(`landing: could not settle ${taskId}:`, error)
  }
  for (const write of writes) perform(write)
  return writes.length > 0
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
