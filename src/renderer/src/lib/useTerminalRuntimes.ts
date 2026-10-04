import { useEffect, useState } from 'react'
import type { TerminalRuntimeState, TerminalSessionInfo } from '@core/types.js'

/**
 * The main process's semantic state for every open terminal, kept in one place so the tab strip
 * and each surface read the same values. React only mirrors it; it is never the source.
 */
export function useTerminalRuntimes(
  sessions: TerminalSessionInfo[]
): ReadonlyMap<string, TerminalRuntimeState> {
  const [runtimes, setRuntimes] = useState<ReadonlyMap<string, TerminalRuntimeState>>(new Map())

  useEffect(() => {
    return window.api.terminal.onRuntimeState((state) => {
      setRuntimes((current) => new Map(current).set(state.sessionId, state))
    })
  }, [])

  const ids = sessions.map((session) => session.id).join('\n')
  useEffect(() => {
    let mounted = true
    for (const id of ids.split('\n').filter(Boolean)) {
      void window.api.terminal.runtimeState(id).then((state) => {
        if (!mounted || !state) return
        // A pushed update that arrived first is newer than this initial read.
        setRuntimes((current) => (current.has(id) ? current : new Map(current).set(id, state)))
      })
    }
    return () => {
      mounted = false
    }
  }, [ids])

  return runtimes
}
