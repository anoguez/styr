import { useEffect, useState } from 'react'
import type { DiffStat } from '@core/diff.js'

const REFRESH_MS = 30_000

/**
 * Per-task change totals for the cards. Derived from git on demand, never stored: refreshed when
 * the board changes and on a slow timer, because commits do not touch the task files.
 */
export function useDiffStats(workspaceId: string): Map<string, DiffStat> {
  const [stats, setStats] = useState<Map<string, DiffStat>>(new Map())

  useEffect(() => {
    let cancelled = false
    let pending: number | undefined
    const load = (): void => {
      void window.api.git.diffStats().then((next) => {
        if (!cancelled) setStats(new Map(Object.entries(next)))
      })
    }
    const soon = (): void => {
      window.clearTimeout(pending)
      pending = window.setTimeout(load, 1000)
    }
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    const unsubscribe = window.api.tasks.onChanged(soon)
    return () => {
      cancelled = true
      window.clearTimeout(pending)
      window.clearInterval(timer)
      unsubscribe()
    }
  }, [workspaceId])

  return stats
}
