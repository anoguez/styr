import { useEffect, useState } from 'react'
import type { TaskDiff } from '@core/diff.js'
import type { Task } from '@core/types.js'

/**
 * A task's changes for the Changes button. `noGit` is set when the task's folder is not a git
 * repository (non-code work): there is nothing to show changes of, so the button hides.
 */
export function useTaskDiff(task: Task | null): { changes: TaskDiff | null; noGit: boolean } {
  const [changes, setChanges] = useState<TaskDiff | null>(null)
  const [noGit, setNoGit] = useState(false)
  useEffect(() => {
    if (!task) return
    let cancelled = false
    void window.api.git.taskDiff(task.id).then((result) => {
      if (cancelled) return
      setChanges('error' in result ? null : result)
      setNoGit('error' in result && result.error.endsWith('is not a git repository'))
    })
    return () => {
      cancelled = true
    }
  }, [task])
  return { changes, noGit }
}
