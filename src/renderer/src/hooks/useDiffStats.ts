import { useEffect, useState } from 'react'
import type { DiffStat } from '@core/diff.js'

const REFRESH_MS = 30_000

/** Same tasks with the same counts. A new Map each poll would re-render the whole board for nothing. */
export function sameDiffStats(a: Map<string, DiffStat>, b: Map<string, DiffStat>): boolean {
  if (a.size !== b.size) return false
  for (const [id, stat] of a) {
    const other = b.get(id)
    if (
      !other ||
      other.added !== stat.added ||
      other.removed !== stat.removed ||
      other.files !== stat.files
    )
      return false
  }
  return true
}

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
      // A hidden window shows no cards; it refreshes once when it comes back.
      if (document.hidden) return
      void window.api.git.diffStats().then((next) => {
        if (cancelled) return
        const incoming = new Map(Object.entries(next))
        setStats((current) => (sameDiffStats(current, incoming) ? current : incoming))
      })
    }
    const soon = (): void => {
      window.clearTimeout(pending)
      pending = window.setTimeout(load, 1000)
    }
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    const onVisible = (): void => {
      if (!document.hidden) load()
    }
    document.addEventListener('visibilitychange', onVisible)
    const unsubscribe = window.api.tasks.onChanged(soon)
    return () => {
      cancelled = true
      window.clearTimeout(pending)
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribe()
    }
  }, [workspaceId])

  return stats
}
