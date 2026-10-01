import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '@core/types.js'

export function useSettings(): {
  settings: Settings | null
  save: (next: Settings) => Promise<void>
} {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
    return window.api.settings.onChanged(setSettings)
  }, [])

  const save = useCallback(async (next: Settings) => {
    setSettings(await window.api.settings.save(next))
  }, [])

  return { settings, save }
}
