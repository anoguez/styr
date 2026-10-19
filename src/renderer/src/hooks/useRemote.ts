import { useEffect, useState } from 'react'
import type { RemoteState } from '@core/types.js'
import { NO_REMOTE } from '../lib/remoteStatus.js'

/**
 * Remote workspaces' connections, pushed by the main process on every change. The network coming
 * back is a reason to retry at once rather than wait out the backoff; the main process has no
 * event for it, so the window reports it.
 */
export function useRemote(): RemoteState {
  const [state, setState] = useState<RemoteState>(NO_REMOTE)

  useEffect(() => {
    let pushed = false
    const unsubscribe = window.api.remote.onState((next) => {
      pushed = true
      setState(next)
    })
    void window.api.remote.state().then((first) => {
      if (!pushed) setState(first)
    })
    const online = (): void => void window.api.remote.retry()
    window.addEventListener('online', online)
    return () => {
      unsubscribe()
      window.removeEventListener('online', online)
    }
  }, [])

  return state
}
