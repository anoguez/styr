import { addNote, updateTask } from '@core/taskStore.js'
import { loadSettings } from '@core/settingsStore.js'
import { worktreeKey, type Task } from '@core/types.js'
import { LandingCache } from '@core/landingCache.js'
import {
  branchLanding,
  cleanupLandedTask,
  isRepeatNote,
  landingFingerprint,
  refListing
} from '@core/worktree.js'
import { queryTasks } from './taskIndex.js'

/** git is slow enough (~0.2s a task) that re-checking every kept worktree on each write froze the app. */
const checked = new LandingCache(5 * 60_000)

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
  // One ref listing per repository per pass, not one per task.
  const listings = new Map<string, string | undefined>()
  const listingFor = (path: string): string | undefined => {
    if (!listings.has(path)) listings.set(path, refListing(path))
    return listings.get(path)
  }
  for (const task of queryTasks()) {
    if (!task.useWorktree || !task.repoPath) continue
    if (task.status !== 'in_review' && !(task.status === 'done' && task.worktreePath)) continue
    const key = worktreeKey(workspaceId, task.id)
    const cacheKey = `${workspaceId}:${task.id}`
    try {
      const refs = landingFingerprint(listingFor(task.repoPath), key, task.baseBranch)
      const fingerprint = `${task.status}|${task.worktreePath ?? ''}|${refs}`
      if (checked.isFresh(cacheKey, fingerprint)) continue
      const wroteTask = settle(task, task.repoPath, key)
      if (wroteTask) checked.forget(cacheKey)
      else checked.remember(cacheKey, fingerprint)
      wrote = wroteTask || wrote
    } catch {
      // a git failure must never break a refresh
    }
  }
  return wrote
}

function settle(task: Task, repoPath: string, key: string): boolean {
  if (task.status === 'in_review') {
    const landing = branchLanding(repoPath, key, task.baseBranch)
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
  const result = cleanupLandedTask(repoPath, key, task.baseBranch)
  let wrote = false
  if (result.worktreeRemoved && task.worktreePath) {
    updateTask(task.id, { worktreePath: undefined })
    wrote = true
  }
  // Deduped against the task's own Activity, which survives a restart; a refusal is reported once.
  const message = result.notes.join(' ')
  if (message && !isRepeatNote(task.activity, 'styr', message)) {
    addNote(task.id, 'styr', message)
    wrote = true
  }
  return wrote
}
