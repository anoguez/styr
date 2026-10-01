import { useEffect, useState } from 'react'
import type { UpdateState } from '@core/types.js'

/** The main process's updater state, kept live. Null until the first read returns. */
export function useUpdates(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    void window.api.updates.state().then(setState)
    return window.api.updates.onState(setState)
  }, [])

  return state
}
