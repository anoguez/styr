import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { RemoteState, TerminalSessionInfo } from '@core/types.js'
import {
  findTaskSession,
  initialTerminalSessions,
  stripSessions,
  terminalSessionsReducer
} from '../lib/terminalSessions'

/** Open terminal tabs, the active one and the panel's visibility; the rules are in the reducer. */
export function useTerminalSessions() {
  const [state, dispatch] = useReducer(terminalSessionsReducer, initialTerminalSessions)

  useEffect(() => {
    void window.api.terminal.list().then((sessions) => dispatch({ type: 'load', sessions }))
    void window.api.terminal.detachedList().then((ids) => dispatch({ type: 'detached', ids }))
    const offDetached = window.api.terminal.onDetachedChanged((ids) =>
      dispatch({ type: 'detached', ids })
    )
    const offExit = window.api.terminal.onExit(({ id }) => dispatch({ type: 'remove', id }))
    return () => {
      offDetached()
      offExit()
    }
  }, [])

  // Read through a ref, so `select` and `adopt` stay stable for their many callers.
  const detachedRef = useRef(state.detached)
  detachedRef.current = state.detached
  /** A tab in its own window is focused there; true when that is where it went. */
  const focusDetached = useCallback((id: string): boolean => {
    if (!detachedRef.current.includes(id)) return false
    void window.api.terminal.detach(id)
    return true
  }, [])

  const adopt = useCallback(
    (session: TerminalSessionInfo) => {
      focusDetached(session.id)
      dispatch({ type: 'adopt', session })
    },
    [focusDetached]
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
  const select = useCallback(
    (id: string) => {
      if (!focusDetached(id)) dispatch({ type: 'select', id })
    },
    [focusDetached]
  )
  /** Moves a tab into its own window; the strip follows `terminal:detachedChanged`. */
  const detach = useCallback((id: string) => void window.api.terminal.detach(id), [])
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
      select(session.id)
      return true
    },
    [sessions, select]
  )
  const strip = useMemo(() => stripSessions(state), [state])

  return {
    ...state,
    /** The tabs the strip shows, in order: `sessions` without the detached ones. */
    strip,
    detach,
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
