import { useEffect, useState } from 'react'
import type { WorklogData } from '@core/types.js'

/**
 * The tasks' sessions and tokens over `[from, to)`, from the main process. Fetched again when the
 * span changes and whenever `refresh` does (the board's tasks), so the numbers grow as agents work;
 * the last answer for the same span stays on screen meanwhile. Null until the span's first answer.
 */
export function useWorklog(from: number, to: number, refresh: unknown): WorklogData | null {
  const [loaded, setLoaded] = useState<{ span: string; data: WorklogData } | null>(null)
  const span = `${from}:${to}`
  useEffect(() => {
    let live = true
    window.api.worklog
      .load(from, to)
      .then((data) => {
        if (live) setLoaded({ span: `${from}:${to}`, data })
      })
      .catch((error: unknown) => console.error('Could not load the worklog:', error))
    return () => {
      live = false
    }
  }, [from, to, refresh])
  return loaded?.span === span ? loaded.data : null
}
