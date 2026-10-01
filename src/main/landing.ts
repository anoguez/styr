import { addNote, updateTask } from '@core/taskStore.js'
import { loadSettings } from '@core/config.js'
import { worktreeKey, type Task } from '@core/types.js'
import { branchLanding, cleanupLandedTask } from '@core/worktree.js'
import { queryTasks } from './taskIndex.js'

/** Cleanup outcomes already written to Activity, so a refusal is reported once rather than on every change. */
const reported = new Set<string>()

/**
 * Keeps the board honest about merges without asking any host. An In Review task whose branch has
 * landed on the base moves to Done, and a Done task's worktree and branches are removed. Returns
 * true when it wrote a task file, so the caller re-indexes.
 *
 * Tasks without a worktree are skipped: with no `styr/<id>` branch there is nothing to compare or
 * delete, and the work lives in the user's own checkout.
 */
export function settleLandedTasks(): boolean {
  let wrote = false
  const workspaceId = loadSettings().activeWorkspaceId
  for (const task of queryTasks()) {
    if (!task.useWorktree || !task.repoPath) continue
    try {
      wrote = settle(task, task.repoPath, worktreeKey(workspaceId, task.id)) || wrote
    } catch {
      // a git failure must never break a refresh
    }
  }
  return wrote
}

function settle(task: Task, repoPath: string, key: string): boolean {
  if (task.status === 'in_review') {
    const landing = branchLanding(repoPath, key)
    if (!landing?.landed) return false
    updateTask(task.id, { status: 'done' })
    addNote(task.id, 'styr', `Work landed on ${landing.base}; moved to done.`)
    cleanup(task, repoPath, key)
    return true
  }
  if (task.status === 'done' && task.worktreePath) return cleanup(task, repoPath, key)
  return false
}

function cleanup(task: Task, repoPath: string, key: string): boolean {
  const result = cleanupLandedTask(repoPath, key)
  const noteKey = `${key}:${result.notes.join('|')}`
  let wrote = false
  if (result.worktreeRemoved && task.worktreePath) {
    updateTask(task.id, { worktreePath: undefined })
    wrote = true
  }
  if (result.notes.length > 0 && !reported.has(noteKey)) {
    reported.add(noteKey)
    addNote(task.id, 'styr', result.notes.join(' '))
    wrote = true
  }
  return wrote
}
