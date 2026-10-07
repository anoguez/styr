import { useCallback, useEffect, useState } from 'react'
import type { AutoDispatchState } from '@core/types.js'

const OFF: AutoDispatchState = { on: false }

/**
 * Auto-run's state, owned by the main process. It is re-read when the workspace or its settings
 * change, because the flag belongs to a workspace and the pause banner to the board it happened on.
 */
export function useAutoDispatch(workspaceId: string | undefined): {
  state: AutoDispatchState
  setOn: (on: boolean) => void
} {
  const [state, setState] = useState<AutoDispatchState>(OFF)

  useEffect(() => {
    let current = true
    const refresh = (): void => {
      void window.api.orchestrate.autoState().then((next) => current && setState(next))
    }
    refresh()
    const offState = window.api.orchestrate.onAutoState(setState)
    const offSettings = window.api.settings.onChanged(refresh)
    return () => {
      current = false
      offState()
      offSettings()
    }
  }, [workspaceId])

  const setOn = useCallback((on: boolean) => {
    setState((previous) => ({ ...previous, on, paused: undefined }))
    void window.api.orchestrate.setAuto(on).then(setState)
  }, [])

  return { state, setOn }
}
