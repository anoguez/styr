import { useEffect, useState } from 'react'
import type { Task } from '@core/types.js'

/**
 * Runs the menu bar's "activate this task" requests. A request can name a task of a workspace that is
 * still loading (the menu bar switches first), so it waits for the board to hold the task. If it never
 * does — a search can hide it — it runs anyway, because the main process finds tasks in the index,
 * not on the board.
 */
export function usePendingActivation(tasks: Task[], activateTask: (taskId: string) => void): void {
  const [pending, setPending] = useState<string | null>(null)
  useEffect(() => window.api.tasks.onActivateRequested(setPending), [])
  useEffect(() => {
    if (!pending) return
    const run = (): void => {
      setPending(null)
      activateTask(pending)
    }
    if (tasks.some((task) => task.id === pending)) return run()
    const timer = setTimeout(run, 1500)
    return () => clearTimeout(timer)
  }, [pending, tasks, activateTask])
}
