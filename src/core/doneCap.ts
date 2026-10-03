import type { DoneCap, Task } from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000

export function finishedAt(task: Task): string {
  return task.doneAt ?? task.updatedAt
}

/**
 * Splits the Done column into what the board shows and what the cap hides. Recency decides who is
 * hidden (the newest finished work stays), while `visible` keeps the board order the user arranged.
 * Pure so the rule is testable without a renderer; a limit of 0 is off.
 */
export function applyDoneCap(
  done: Task[],
  cap: DoneCap,
  now: number = Date.now()
): { visible: Task[]; hidden: Task[] } {
  const newestFirst = [...done].sort((a, b) => finishedAt(b).localeCompare(finishedAt(a)))
  const hiddenIds = new Set<string>()
  newestFirst.forEach((task, index) => {
    const finished = Date.parse(finishedAt(task))
    const tooOld =
      cap.maxAgeDays > 0 && Number.isFinite(finished) && now - finished > cap.maxAgeDays * DAY_MS
    const overCount = cap.maxCount > 0 && index >= cap.maxCount
    if (tooOld || overCount) hiddenIds.add(task.id)
  })
  return {
    visible: done.filter((task) => !hiddenIds.has(task.id)),
    hidden: done.filter((task) => hiddenIds.has(task.id))
  }
}
