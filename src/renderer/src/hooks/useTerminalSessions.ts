import { useCallback, useEffect, useReducer } from 'react'
import type { TerminalSessionInfo } from '@core/types.js'
import {
  findTaskSession,
  initialTerminalSessions,
  terminalSessionsReducer
} from '../lib/terminalSessions'

/** Open terminal tabs, the active one and the panel's visibility; the rules are in the reducer. */
export function useTerminalSessions() {
  const [state, dispatch] = useReducer(terminalSessionsReducer, initialTerminalSessions)

  useEffect(() => {
    void window.api.terminal.list().then((sessions) => dispatch({ type: 'load', sessions }))
    return window.api.terminal.onExit(({ id }) => dispatch({ type: 'remove', id }))
  }, [])

  const adopt = useCallback(
    (session: TerminalSessionInfo) => dispatch({ type: 'adopt', session }),
    []
  )
  const select = useCallback((id: string) => dispatch({ type: 'select', id }), [])
  const reorder = useCallback((ids: string[]) => dispatch({ type: 'reorder', ids }), [])
  const toggleTerminal = useCallback(() => dispatch({ type: 'toggleTerminal' }), [])
  const close = useCallback(async (id: string) => {
    await window.api.terminal.kill(id)
    dispatch({ type: 'remove', id })
  }, [])

  const { sessions } = state
  /** Focuses the task's open tab; false when it has none, so the caller can launch one. */
  const activateForTask = useCallback(
    (taskId: string, workspaceId: string): boolean => {
      const session = findTaskSession(sessions, taskId, workspaceId)
      if (!session) return false
      dispatch({ type: 'select', id: session.id })
      return true
    },
    [sessions]
  )

  return { ...state, adopt, select, reorder, toggleTerminal, close, activateForTask }
}
