import { useEffect, useState } from 'react'
import type { ProviderUsage } from '@core/usage.js'

/** The last Claude rate-limit reading the usage mod wrote, kept live. Null until there is one. */
export function useClaudeUsage(): ProviderUsage | null {
  const [usage, setUsage] = useState<ProviderUsage | null>(null)

  useEffect(() => {
    void window.api.usage.claude().then(setUsage)
    return window.api.usage.onClaude(setUsage)
  }, [])

  return usage
}
