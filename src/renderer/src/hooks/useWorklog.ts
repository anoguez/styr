import { useEffect, useState } from 'react'
import type { WorklogTask } from '@core/types.js'

/**
 * The tasks' working time over `[from, to)`, from the main process. Fetched again when the span
 * changes and whenever `refresh` does (the board's tasks, so hours grow as agents work); the last
 * answer for the same span stays on screen meanwhile. Null until the span's first answer.
 */
export function useWorklog(from: number, to: number, refresh: unknown): WorklogTask[] | null {
  const [loaded, setLoaded] = useState<{ span: string; tasks: WorklogTask[] } | null>(null)
  const span = `${from}:${to}`
  useEffect(() => {
    let live = true
    window.api.worklog
      .load(from, to)
      .then((tasks) => {
        if (live) setLoaded({ span: `${from}:${to}`, tasks })
      })
      .catch((error: unknown) => console.error('Could not load the worklog:', error))
    return () => {
      live = false
    }
  }, [from, to, refresh])
  return loaded?.span === span ? loaded.tasks : null
}
