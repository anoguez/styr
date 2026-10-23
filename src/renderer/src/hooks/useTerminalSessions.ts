import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { RemoteState, TerminalSessionInfo } from '@core/types.js'
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
  const merge = useCallback(
    (sessions: TerminalSessionInfo[]) => dispatch({ type: 'merge', sessions }),
    []
  )
  const restore = useCallback(
    (sessions: TerminalSessionInfo[], activeId?: string) =>
      dispatch({ type: 'restore', sessions, activeId }),
    []
  )
  const select = useCallback((id: string) => dispatch({ type: 'select', id }), [])
  const reorder = useCallback((ids: string[]) => dispatch({ type: 'reorder', ids }), [])
  const toggleTerminal = useCallback(() => dispatch({ type: 'toggleTerminal' }), [])
  const close = useCallback(async (id: string) => {
    await window.api.terminal.kill(id)
    dispatch({ type: 'remove', id })
  }, [])

  const { sessions, activeSession } = state
  // The main process saves the layout; it needs the order and the active tab only from here.
  const ids = sessions.map((session) => session.id).join(',')
  useEffect(() => {
    window.api.terminal.setLayout(ids ? ids.split(',') : [], activeSession)
  }, [ids, activeSession])
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

  return {
    ...state,
    adopt,
    merge,
    restore,
    select,
    reorder,
    toggleTerminal,
    close,
    activateForTask
  }
}

/**
 * Each time a remote host connects, its running terminals join the tabs: the ones started while
 * this window was away (or before the app opened) included. Open tabs are kept as they are.
 */
export function useRemoteSessions(
  remote: RemoteState,
  merge: (sessions: TerminalSessionInfo[]) => void
): void {
  const connected = useRef(new Set<string>())
  useEffect(() => {
    const now = new Set(
      remote.hosts.filter((host) => host.status === 'connected').map((host) => host.host)
    )
    const joined = [...now].some((host) => !connected.current.has(host))
    connected.current = now
    if (joined) void window.api.terminal.list().then(merge)
  }, [remote, merge])
}
