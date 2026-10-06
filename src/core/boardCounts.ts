import type { Task, TaskStatus } from './types.js'

/**
 * What the status bar summarises: work still open. Done is finished, so it would only ever grow
 * the number. Pure so the rule is testable without a renderer.
 */
export function openTaskCounts(board: Record<TaskStatus, Task[]>): {
  total: number
  needsSpec: number
} {
  const open = Object.entries(board)
    .filter(([status]) => status !== 'done')
    .flatMap(([, tasks]) => tasks)
  return {
    total: open.length,
    needsSpec: open.filter((task) => task.readiness === 'needs_spec').length
  }
}
