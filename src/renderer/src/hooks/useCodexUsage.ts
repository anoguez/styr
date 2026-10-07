import { useEffect, useState } from 'react'
import type { ContextUsage, ProviderUsage } from '@core/usage.js'

export interface CodexUsage {
  usage: ProviderUsage | null
  context: ContextUsage | null
}

/** Codex writes its numbers into the thread's rollout file with no event to wait for, so poll. */
const POLL_MS = 5000

/** This terminal's Codex usage, or null when `enabled` is off or there is nothing to read yet. */
export function useCodexUsage(terminalId: string, enabled: boolean): CodexUsage | null {
  const [reading, setReading] = useState<CodexUsage | null>(null)

  useEffect(() => {
    if (!enabled) {
      setReading(null)
      return
    }
    let live = true
    const read = (): void => {
      void window.api.usage.codex(terminalId).then((next) => {
        if (live && next) setReading(next)
      })
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [terminalId, enabled])

  return reading
}
