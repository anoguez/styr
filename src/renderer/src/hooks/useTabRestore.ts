import { useCallback, useEffect, useRef, useState } from 'react'
import { restoreSummary } from '@core/terminalLayout.js'
import type { TabsOffer, TerminalSessionInfo } from '@core/types.js'

export interface TabRestore {
  /** The last session's tabs waiting for an answer in this workspace. */
  offer: TabsOffer | null
  /** What a finished restore did, until it is closed. */
  summary: string | null
  busy: boolean
  restore(): void
  dismiss(): void
  closeSummary(): void
}

/**
 * Asks the main process what the last session's tabs offer, at start and again whenever another
 * workspace becomes the active one (its agent tabs are offered then). `restoreTabs: always` restores
 * at once. The tabs themselves are opened in the main process; this only shows them.
 */
export function useTabRestore(
  workspaceId: string,
  restored: (sessions: TerminalSessionInfo[], activeId?: string) => void
): TabRestore {
  const [offer, setOffer] = useState<TabsOffer | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const onRestored = useRef(restored)
  onRestored.current = restored

  const run = useCallback(async () => {
    setBusy(true)
    try {
      const result = await window.api.terminal.restoreLayout()
      onRestored.current(result.sessions, result.activeId)
      setOffer(null)
      if (result.skipped.length > 0)
        setSummary(restoreSummary(result.sessions.length, result.skipped))
      // Agent tabs of another workspace wait for it; nothing more is offered here.
    } catch (error) {
      setSummary(`Could not restore the tabs: ${error instanceof Error ? error.message : error}`)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    let current = true
    void window.api.terminal.pendingLayout().then((pending) => {
      if (!current) return
      setOffer(pending)
      setSummary(null)
      if (pending?.auto) void run()
    })
    return () => {
      current = false
    }
  }, [workspaceId, run])

  const dismiss = useCallback(() => {
    setOffer(null)
    void window.api.terminal.dismissLayout()
  }, [])

  return {
    offer,
    summary,
    busy,
    restore: () => void run(),
    dismiss,
    closeSummary: () => setSummary(null)
  }
}
