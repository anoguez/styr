import { describe, expect, it } from 'vitest'
import type { TerminalSessionInfo } from '@core/types.js'
import {
  findTaskSession,
  initialTerminalSessions,
  terminalSessionsReducer as reduce,
  type TerminalSessionsState
} from './terminalSessions.js'

const session = (id: string, taskId?: string, workspaceId = 'default'): TerminalSessionInfo =>
  ({ id, taskId, workspaceId, title: id }) as TerminalSessionInfo

const withTabs = (...ids: string[]): TerminalSessionsState => ({
  ...initialTerminalSessions,
  sessions: ids.map((id) => session(id))
})

describe('terminalSessionsReducer', () => {
  it('adopts a session, activating it and opening the panel', () => {
    const next = reduce(initialTerminalSessions, { type: 'adopt', session: session('a') })
    expect(next).toMatchObject({ activeSession: 'a', terminalOpen: true })
    expect(next.sessions).toHaveLength(1)
  })

  it('does not add a session id twice, but still focuses it', () => {
    const state = { ...withTabs('a', 'b'), activeSession: 'b' }
    const next = reduce(state, { type: 'adopt', session: session('a') })
    expect(next.sessions).toBe(state.sessions)
    expect(next.activeSession).toBe('a')
  })

  it('load keeps the current active tab, else takes the first', () => {
    const loaded = [session('a'), session('b')]
    expect(reduce(initialTerminalSessions, { type: 'load', sessions: loaded }).activeSession).toBe(
      'a'
    )
    const kept = reduce(
      { ...initialTerminalSessions, activeSession: 'z' },
      { type: 'load', sessions: loaded }
    )
    expect(kept.activeSession).toBe('z')
  })

  it('removing the active tab clears the selection; others leave it', () => {
    const state = { ...withTabs('a', 'b'), activeSession: 'a' }
    expect(reduce(state, { type: 'remove', id: 'b' }).activeSession).toBe('a')
    const next = reduce(state, { type: 'remove', id: 'a' })
    expect(next.activeSession).toBeNull()
    expect(next.sessions.map((s) => s.id)).toEqual(['b'])
  })

  it('select activates and opens the panel', () => {
    const next = reduce(withTabs('a', 'b'), { type: 'select', id: 'b' })
    expect(next).toMatchObject({ activeSession: 'b', terminalOpen: true })
  })

  it('reorders by id, keeping the same session objects and dropping unknown ids', () => {
    const state = withTabs('a', 'b', 'c')
    const next = reduce(state, { type: 'reorder', ids: ['c', 'x', 'a', 'b'] })
    expect(next.sessions.map((s) => s.id)).toEqual(['c', 'a', 'b'])
    expect(next.sessions[1]).toBe(state.sessions[0])
  })

  it('toggles the panel', () => {
    const open = reduce(initialTerminalSessions, { type: 'toggleTerminal' })
    expect(open.terminalOpen).toBe(true)
    expect(reduce(open, { type: 'toggleTerminal' }).terminalOpen).toBe(false)
  })
})

describe('findTaskSession', () => {
  it('matches the task in its own workspace only', () => {
    const sessions = [session('a', 'TASK-0001', 'other'), session('b', 'TASK-0001', 'default')]
    expect(findTaskSession(sessions, 'TASK-0001', 'default')?.id).toBe('b')
    expect(findTaskSession(sessions, 'TASK-0001', 'third')).toBeUndefined()
    expect(findTaskSession(sessions, 'TASK-0002', 'default')).toBeUndefined()
  })
})
