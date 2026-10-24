import { isPlanRun } from './planning.js'
import type { Settings, Task } from './types.js'

/** The tag every "Ask agent" task carries (`askDraft`, `terminalDraft`). Removing it keeps the card. */
export const ASK_TAG = 'ask'

export function isAskTask(task: { tags: readonly string[] }): boolean {
  return task.tags.includes(ASK_TAG)
}

/**
 * Whether the task leaves the board when its agent's terminal exits. Planning runs are throwaway,
 * so they always go. An ask goes only while still In Progress (anyone who moved it on meant to keep
 * it) and when the workspace archives asks. Pure: no files, no git.
 */
export function shouldArchiveOnExit(
  task: Pick<Task, 'tags' | 'status' | 'archivedAt'>,
  settings: Pick<Settings, 'autoArchiveAsk'>
): boolean {
  if (task.archivedAt) return false
  if (isPlanRun(task)) return true
  return settings.autoArchiveAsk && isAskTask(task) && task.status === 'in_progress'
}
