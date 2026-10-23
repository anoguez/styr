import type { TerminalSessionInfo } from '@core/types.js'

export interface TerminalSessionsState {
  sessions: TerminalSessionInfo[]
  activeSession: string | null
  terminalOpen: boolean
}

export type TerminalSessionsAction =
  | { type: 'load'; sessions: TerminalSessionInfo[] }
  /** Sessions found later (a remote host connected): added after the open tabs, none replaced. */
  | { type: 'merge'; sessions: TerminalSessionInfo[] }
  | { type: 'adopt'; session: TerminalSessionInfo }
  /** A restore finished: its tabs join after the open ones, the saved active one is focused. */
  | { type: 'restore'; sessions: TerminalSessionInfo[]; activeId?: string }
  | { type: 'remove'; id: string }
  | { type: 'select'; id: string }
  | { type: 'reorder'; ids: string[] }
  | { type: 'toggleTerminal' }

export const initialTerminalSessions: TerminalSessionsState = {
  sessions: [],
  activeSession: null,
  terminalOpen: false
}

/** The tab of a task in one workspace; `TASK-0001` exists in every workspace, so both must match. */
export function findTaskSession(
  sessions: TerminalSessionInfo[],
  taskId: string,
  workspaceId: string
): TerminalSessionInfo | undefined {
  return sessions.find(
    (session) => session.taskId === taskId && session.workspaceId === workspaceId
  )
}

export function terminalSessionsReducer(
  state: TerminalSessionsState,
  action: TerminalSessionsAction
): TerminalSessionsState {
  switch (action.type) {
    case 'load':
      return {
        ...state,
        sessions: action.sessions,
        activeSession: state.activeSession ?? action.sessions[0]?.id ?? null
      }
    case 'merge': {
      const open = new Set(state.sessions.map((session) => session.id))
      const added = action.sessions.filter((session) => !open.has(session.id))
      return added.length === 0 ? state : { ...state, sessions: [...state.sessions, ...added] }
    }
    case 'adopt':
      // The same session can arrive twice (a second launch returns the open one): one tab.
      return {
        sessions: state.sessions.some((existing) => existing.id === action.session.id)
          ? state.sessions
          : [...state.sessions, action.session],
        activeSession: action.session.id,
        terminalOpen: true
      }
    case 'restore': {
      if (action.sessions.length === 0) return state
      const open = new Set(state.sessions.map((session) => session.id))
      const added = action.sessions.filter((session) => !open.has(session.id))
      const ids = new Set(action.sessions.map((session) => session.id))
      const focus = action.activeId ?? action.sessions[action.sessions.length - 1]?.id
      return {
        sessions: [...state.sessions, ...added],
        // A tab the launch gate handed back (already open) can be the saved active one too.
        activeSession: focus && (ids.has(focus) || open.has(focus)) ? focus : state.activeSession,
        terminalOpen: true
      }
    }
    case 'remove': {
      const sessions = state.sessions.filter((session) => session.id !== action.id)
      if (state.activeSession !== action.id) return { ...state, sessions }
      // Closing the active tab focuses its neighbour: the next tab, else the previous one.
      const index = state.sessions.findIndex((session) => session.id === action.id)
      const neighbour = sessions[Math.min(Math.max(index, 0), sessions.length - 1)]
      return { ...state, sessions, activeSession: neighbour?.id ?? null }
    }
    case 'select':
      return { ...state, activeSession: action.id, terminalOpen: true }
    case 'reorder': {
      const byId = new Map(state.sessions.map((session) => [session.id, session]))
      return {
        ...state,
        sessions: action.ids
          .map((id) => byId.get(id))
          .filter((session): session is TerminalSessionInfo => session !== undefined)
      }
    }
    case 'toggleTerminal':
      return { ...state, terminalOpen: !state.terminalOpen }
  }
}
