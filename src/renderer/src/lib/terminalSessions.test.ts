import { describe, expect, it } from 'vitest'
import type { TerminalSessionInfo } from '@core/types.js'
import {
  findTaskSession,
  initialTerminalSessions,
  stripSessions,
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

  it('restores tabs after the open ones, focusing the saved active tab and opening the panel', () => {
    const state = { ...withTabs('x'), activeSession: 'x' }
    const next = reduce(state, {
      type: 'restore',
      sessions: [session('a'), session('b'), session('c')],
      activeId: 'b'
    })
    expect(next.sessions.map((tab) => tab.id)).toEqual(['x', 'a', 'b', 'c'])
    expect(next).toMatchObject({ activeSession: 'b', terminalOpen: true })
  })

  it('restores nothing when every tab was skipped, and never doubles an open tab', () => {
    const state = withTabs('x')
    expect(reduce(state, { type: 'restore', sessions: [] })).toBe(state)
    const again = reduce(state, { type: 'restore', sessions: [session('x')], activeId: 'x' })
    expect(again.sessions.map((tab) => tab.id)).toEqual(['x'])
    expect(again.activeSession).toBe('x')
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

  it('removing the active tab focuses the next tab, else the previous; others leave it', () => {
    const state = { ...withTabs('a', 'b', 'c'), activeSession: 'b' }
    expect(reduce(state, { type: 'remove', id: 'c' }).activeSession).toBe('b')
    const next = reduce(state, { type: 'remove', id: 'b' })
    expect(next.activeSession).toBe('c')
    expect(next.sessions.map((s) => s.id)).toEqual(['a', 'c'])
    const last = reduce({ ...state, activeSession: 'c' }, { type: 'remove', id: 'c' })
    expect(last.activeSession).toBe('b')
    const only = reduce({ ...withTabs('a'), activeSession: 'a' }, { type: 'remove', id: 'a' })
    expect(only.activeSession).toBeNull()
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

describe('merge', () => {
  it('adds sessions a remote host brought, after the open tabs, replacing none', () => {
    const state = { ...withTabs('a', 'b'), activeSession: 'b' }
    const next = reduce(state, { type: 'merge', sessions: [session('b'), session('c')] })
    expect(next.sessions.map((tab) => tab.id)).toEqual(['a', 'b', 'c'])
    expect(next.activeSession).toBe('b')
    expect(reduce(next, { type: 'merge', sessions: [session('a')] })).toBe(next)
  })
})

describe('detached tabs', () => {
  const strip = (state: TerminalSessionsState): string[] => stripSessions(state).map((s) => s.id)

  it('leaves the strip, keeps its place in the list and moves focus to its neighbour', () => {
    const state = { ...withTabs('a', 'b', 'c'), activeSession: 'b', terminalOpen: true }
    const next = reduce(state, { type: 'detached', ids: ['b'] })
    expect(next.sessions.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(strip(next)).toEqual(['a', 'c'])
    expect(next.activeSession).toBe('c')
  })

  it('focuses the previous tab when the last one leaves, and none when no tab is left', () => {
    const state = { ...withTabs('a', 'b'), activeSession: 'b' }
    expect(reduce(state, { type: 'detached', ids: ['b'] }).activeSession).toBe('a')
    expect(reduce(state, { type: 'detached', ids: ['a', 'b'] }).activeSession).toBeNull()
  })

  it('comes back at its old position, focused, with the panel open', () => {
    const state = {
      ...withTabs('a', 'b', 'c'),
      activeSession: 'a',
      terminalOpen: false,
      detached: ['b']
    }
    const next = reduce(state, { type: 'detached', ids: [] })
    expect(strip(next)).toEqual(['a', 'b', 'c'])
    expect(next).toMatchObject({ activeSession: 'b', terminalOpen: true })
  })

  it('hides tabs named before they load', () => {
    const early = reduce(initialTerminalSessions, { type: 'detached', ids: ['a'] })
    const loaded = reduce(early, { type: 'load', sessions: [session('a'), session('b')] })
    expect(strip(loaded)).toEqual(['b'])
    expect(loaded.activeSession).toBe('b')
  })

  it('is never selected or adopted into the strip', () => {
    const state = { ...withTabs('a', 'b'), activeSession: 'a', detached: ['b'] }
    expect(reduce(state, { type: 'select', id: 'b' })).toBe(state)
    expect(reduce(state, { type: 'adopt', session: session('b') }).activeSession).toBe('a')
  })

  it('keeps its slot when the strip is reordered around it', () => {
    const state = { ...withTabs('a', 'b', 'c', 'd'), detached: ['b'] }
    const next = reduce(state, { type: 'reorder', ids: ['d', 'a', 'c'] })
    expect(next.sessions.map((s) => s.id)).toEqual(['d', 'b', 'a', 'c'])
  })

  it('forgets a detached session that exits', () => {
    const state = { ...withTabs('a', 'b'), activeSession: 'a', detached: ['b'] }
    const next = reduce(state, { type: 'remove', id: 'b' })
    expect(next.detached).toEqual([])
    expect(next.activeSession).toBe('a')
  })

  it('closing the active tab skips a detached neighbour', () => {
    const state = { ...withTabs('a', 'b', 'c'), activeSession: 'a', detached: ['b'] }
    expect(reduce(state, { type: 'remove', id: 'a' }).activeSession).toBe('c')
  })
})
