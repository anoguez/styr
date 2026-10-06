import type { Task } from './types.js'

type Lookup = ReadonlyMap<string, Pick<Task, 'id' | 'status' | 'blockedBy'>>

export function indexTasks<T extends Pick<Task, 'id'>>(tasks: readonly T[]): Map<string, T> {
  return new Map(tasks.map((task) => [task.id, task]))
}

/**
 * The blockers still holding a task back. Blocked is derived, never stored: a blocker that is Done
 * (archived or not) is finished, an unknown id is ignored so a typo cannot hold a task forever, and
 * an archived blocker that is not Done still counts — archiving hides a task, it does not finish it.
 * Only direct blockers are read, so a cycle cannot loop; a blocker that is itself blocked is not
 * Done and keeps its dependants blocked without any recursion.
 */
export function openBlockers<T extends Pick<Task, 'id' | 'status'>>(
  task: Pick<Task, 'id' | 'status' | 'blockedBy'>,
  byId: ReadonlyMap<string, T>
): T[] {
  if (task.status === 'done') return []
  const open: T[] = []
  for (const id of task.blockedBy) {
    const blocker = byId.get(id)
    if (blocker && blocker.status !== 'done' && id !== task.id) open.push(blocker)
  }
  return open
}

/** Blocker ids that match no task in the workspace. */
export function danglingBlockers(task: Pick<Task, 'blockedBy'>, byId: Lookup): string[] {
  return task.blockedBy.filter((id) => !byId.has(id))
}

/**
 * The cycle `taskId` would sit in if it were blocked by `blockedBy`, as a path starting and ending
 * at `taskId`, or null. Self-reference is the shortest cycle.
 */
export function findCycle(
  taskId: string,
  blockedBy: readonly string[],
  byId: Lookup
): string[] | null {
  const visited = new Set<string>()
  const walk = (id: string, path: string[]): string[] | null => {
    if (id === taskId) return [...path, id]
    if (visited.has(id)) return null
    visited.add(id)
    for (const next of byId.get(id)?.blockedBy ?? []) {
      const found = walk(next, [...path, id])
      if (found) return found
    }
    return null
  }
  for (const first of blockedBy) {
    const found = walk(first, [taskId])
    if (found) return found
  }
  return null
}

/** Why a proposed `blockedBy` list may not be written, or null when it is fine. */
export function blockerProblem(
  taskId: string,
  blockedBy: readonly string[],
  byId: Lookup
): string | null {
  const unknown = blockedBy.filter((id) => id !== taskId && !byId.has(id))
  if (unknown.length > 0) return `Unknown blocker ${unknown.join(', ')}`
  const cycle = findCycle(taskId, blockedBy, byId)
  return cycle ? `Blocking would create a dependency cycle: ${cycle.join(' → ')}` : null
}
