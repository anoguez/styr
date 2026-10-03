import { useCallback, useEffect, useState } from 'react'
import type { Settings, SettingsChange } from '@core/types.js'

export function useSettings(): {
  settings: Settings | null
  /** Saves the app-level keys and one workspace's own. The result is the active workspace's. */
  save: (change: SettingsChange) => Promise<void>
} {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
    return window.api.settings.onChanged(setSettings)
  }, [])

  const save = useCallback(async (change: SettingsChange) => {
    setSettings(await window.api.settings.save(change))
  }, [])

  return { settings, save }
}
