import type { TerminalSessionInfo } from '@core/types.js'

export interface TerminalSessionsState {
  /** Every tab in strip order, detached ones included: they keep their place for docking. */
  sessions: TerminalSessionInfo[]
  /** The active tab of the strip; never a detached one. */
  activeSession: string | null
  terminalOpen: boolean
  /** Sessions shown in their own window (`terminal:detachedChanged`), left out of the strip. */
  detached: readonly string[]
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
  /** The windows changed: these sessions are now detached, the rest are docked. */
  | { type: 'detached'; ids: readonly string[] }

export const initialTerminalSessions: TerminalSessionsState = {
  sessions: [],
  activeSession: null,
  terminalOpen: false,
  detached: []
}

/** The tabs the strip draws: every session not shown in a window of its own. */
export function stripSessions(state: TerminalSessionsState): TerminalSessionInfo[] {
  if (state.detached.length === 0) return state.sessions
  const away = new Set(state.detached)
  return state.sessions.filter((session) => !away.has(session.id))
}

/** The strip tab to focus when `id` leaves it: the next tab, else the previous one. */
function neighbour(
  sessions: TerminalSessionInfo[],
  away: ReadonlySet<string>,
  id: string
): string | null {
  const index = sessions.findIndex((session) => session.id === id)
  const after = sessions.slice(index + 1).find((session) => !away.has(session.id))
  const before = sessions
    .slice(0, Math.max(index, 0))
    .reverse()
    .find((session) => !away.has(session.id))
  return (after ?? before)?.id ?? null
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
        activeSession:
          state.activeSession ??
          action.sessions.find((session) => !state.detached.includes(session.id))?.id ??
          null
      }
    case 'merge': {
      const open = new Set(state.sessions.map((session) => session.id))
      const added = action.sessions.filter((session) => !open.has(session.id))
      return added.length === 0 ? state : { ...state, sessions: [...state.sessions, ...added] }
    }
    case 'adopt': {
      // The same session can arrive twice (a second launch returns the open one): one tab.
      const sessions = state.sessions.some((existing) => existing.id === action.session.id)
        ? state.sessions
        : [...state.sessions, action.session]
      // A session with a window of its own stays there (`useTerminalSessions` focuses it).
      if (state.detached.includes(action.session.id)) return { ...state, sessions }
      return { ...state, sessions, activeSession: action.session.id, terminalOpen: true }
    }
    case 'restore': {
      if (action.sessions.length === 0) return state
      const open = new Set(state.sessions.map((session) => session.id))
      const added = action.sessions.filter((session) => !open.has(session.id))
      const ids = new Set(action.sessions.map((session) => session.id))
      const focus = action.activeId ?? action.sessions[action.sessions.length - 1]?.id
      return {
        ...state,
        sessions: [...state.sessions, ...added],
        // A tab the launch gate handed back (already open) can be the saved active one too.
        activeSession: focus && (ids.has(focus) || open.has(focus)) ? focus : state.activeSession,
        terminalOpen: true
      }
    }
    case 'remove': {
      const sessions = state.sessions.filter((session) => session.id !== action.id)
      const detached = state.detached.filter((id) => id !== action.id)
      if (state.activeSession !== action.id) return { ...state, sessions, detached }
      // Closing the active tab focuses its neighbour: the next tab, else the previous one.
      return {
        ...state,
        sessions,
        detached,
        activeSession: neighbour(state.sessions, new Set(state.detached), action.id)
      }
    }
    case 'select':
      // A detached tab is focused in its own window (`useTerminalSessions`), never in the strip.
      if (state.detached.includes(action.id)) return state
      return { ...state, activeSession: action.id, terminalOpen: true }
    case 'detached': {
      // Kept as given: the list can arrive before the tabs load, and must still hide them then.
      const known = new Set(state.sessions.map((session) => session.id))
      const detached = [...action.ids]
      const away = new Set(detached)
      // A tab docked back comes forward where it always was; the last one docked wins.
      const docked = state.detached.filter((id) => !away.has(id) && known.has(id))
      if (docked.length > 0) {
        return { ...state, detached, activeSession: docked.at(-1)!, terminalOpen: true }
      }
      const activeSession =
        state.activeSession && away.has(state.activeSession)
          ? neighbour(state.sessions, away, state.activeSession)
          : state.activeSession
      return { ...state, detached, activeSession }
    }
    case 'reorder': {
      const byId = new Map(state.sessions.map((session) => [session.id, session]))
      const away = new Set(state.detached)
      const moved = action.ids
        .filter((id) => !away.has(id))
        .map((id) => byId.get(id))
        .filter((session): session is TerminalSessionInfo => session !== undefined)
      // The strip reorders the tabs it shows; a detached tab keeps its slot among them.
      const sessions: TerminalSessionInfo[] = []
      for (const session of state.sessions) {
        if (away.has(session.id)) sessions.push(session)
        else if (moved.length > 0) sessions.push(moved.shift()!)
      }
      return { ...state, sessions: [...sessions, ...moved] }
    }
    case 'toggleTerminal':
      return { ...state, terminalOpen: !state.terminalOpen }
  }
}
