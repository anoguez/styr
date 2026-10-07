import { useEffect, useState } from 'react'
import type { ContextUsage } from '@core/usage.js'

/** How full this terminal's Claude context window is, kept live. Null until the usage mod reports. */
export function useContextUsage(terminalId: string): ContextUsage | null {
  const [context, setContext] = useState<ContextUsage | null>(null)

  useEffect(() => {
    setContext(null)
    void window.api.usage.context(terminalId).then(setContext)
    return window.api.usage.onContext((update) => {
      if (update.terminalId === terminalId) setContext(update.context)
    })
  }, [terminalId])

  return context
}
