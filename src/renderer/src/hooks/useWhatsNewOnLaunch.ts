import { useEffect, useState } from 'react'
import { parseChangelog, whatsNewToShow } from '@core/changelog.js'
import type { AppInfo } from '@core/types.js'
import type { AppShellAction } from '../lib/appShell.js'

const SEEN_KEY = 'styr.whatsNew.seen'

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY)
  } catch {
    return null
  }
}

function writeSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version)
  } catch {
    // A convenience: without storage the dialog may repeat, which is harmless.
  }
}

/**
 * Opens What's new once after the app first runs a newer packaged version. A fresh install, a
 * dev build, the same version or a downgrade only record the version. When it does open, the
 * version is stored right away, and it waits for any other modal to close first.
 */
export function useWhatsNewOnLaunch(
  appInfo: AppInfo | null,
  modalOpen: boolean,
  dispatch: (action: AppShellAction) => void
): void {
  const [since, setSince] = useState<string | null>(null)
  const version = appInfo?.version
  const packaged = appInfo?.isPackaged

  useEffect(() => {
    if (!version || !packaged) return
    let live = true
    const seen = readSeen()
    if (seen === null) return writeSeen(version)
    void window.api.app.changelog().then((text) => {
      if (!live) return
      const decision = whatsNewToShow(seen, version, true, text ? parseChangelog(text) : [])
      if (decision.show) setSince(seen)
      else writeSeen(decision.store)
    })
    return () => {
      live = false
    }
  }, [version, packaged])

  useEffect(() => {
    if (since === null || !version || modalOpen) return
    writeSeen(version)
    dispatch({ type: 'whatsNew', request: { mode: 'installed', since } })
    setSince(null)
  }, [since, version, modalOpen, dispatch])
}
