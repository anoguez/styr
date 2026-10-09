import { describe, expect, it } from 'vitest'
import type { AgentState } from '@core/agentState.js'
import type { WorkspaceAgentActivity, WorkspaceBoardSummary } from '@core/types.js'
import {
  agentActivityLabel,
  backgroundBadge,
  boardCounts,
  boardSummaryLabel,
  elsewhereNotice
} from './workspaceStatus.js'

const WORKSPACES = [
  { id: 'default', name: 'Default' },
  { id: 'a', name: 'Client A' },
  { id: 'p', name: 'Personal' }
]

function activity(counts: Partial<Record<AgentState, number>>, review = 0): WorkspaceAgentActivity {
  return { counts: { ready: 0, working: 0, waiting: 0, idle: 0, exited: 0, ...counts }, review }
}

function summary(counts: Partial<WorkspaceBoardSummary>): WorkspaceBoardSummary {
  return { needs: 0, running: 0, next: 0, waiting: 0, review: 0, spec: 0, ...counts }
}

describe('backgroundBadge', () => {
  it('counts waiting agents in background workspaces and names them, with working as context', () => {
    const badge = backgroundBadge(
      {
        activeId: 'default',
        byWorkspace: {
          default: activity({ waiting: 5 }),
          a: activity({ waiting: 1, working: 1 }),
          p: activity({ waiting: 1 })
        }
      },
      WORKSPACES
    )
    expect(badge).toEqual({
      state: 'waiting',
      count: 2,
      label: '2 agents waiting in Client A, Personal · 1 working in Client A'
    })
  })

  it('counts tasks ready for review alongside waiting agents', () => {
    expect(
      backgroundBadge(
        {
          activeId: 'default',
          byWorkspace: {
            default: activity({ idle: 4 }, 4),
            a: activity({ waiting: 1 }),
            p: activity({ idle: 2 }, 2)
          }
        },
        WORKSPACES
      )
    ).toEqual({
      state: 'waiting',
      count: 3,
      label: '1 agent waiting in Client A · 2 ready for review in Personal'
    })
    expect(
      backgroundBadge(
        { activeId: 'default', byWorkspace: { p: activity({ idle: 1, working: 1 }, 1) } },
        WORKSPACES
      )
    ).toEqual({
      state: 'waiting',
      count: 1,
      label: '1 ready for review in Personal · 1 working in Personal'
    })
  })

  it('shows a countless working mark when nothing in the background waits', () => {
    const badge = backgroundBadge(
      {
        activeId: 'a',
        byWorkspace: { a: activity({ waiting: 1 }), default: activity({ working: 2 }) }
      },
      WORKSPACES
    )
    expect(badge).toEqual({ state: 'working', label: '2 working in Default' })
  })

  it('shows nothing for idle, ready or stopped agents, or for the active board alone', () => {
    expect(
      backgroundBadge(
        {
          activeId: 'default',
          byWorkspace: {
            default: activity({ waiting: 3 }),
            a: activity({ idle: 1, ready: 1, exited: 2 })
          }
        },
        WORKSPACES
      )
    ).toBeUndefined()
  })

  it('never badges a single workspace, and ignores ids no longer listed', () => {
    expect(
      backgroundBadge({ activeId: 'x', byWorkspace: { default: activity({ waiting: 1 }) } }, [
        WORKSPACES[0]!
      ])
    ).toBeUndefined()
    expect(
      backgroundBadge(
        { activeId: 'default', byWorkspace: { deleted: activity({ waiting: 1 }) } },
        WORKSPACES
      )
    ).toBeUndefined()
  })

  it('says "1 agent" for a single waiting agent', () => {
    expect(
      backgroundBadge(
        { activeId: 'default', byWorkspace: { p: activity({ waiting: 1 }) } },
        WORKSPACES
      )?.label
    ).toBe('1 agent waiting in Personal')
  })
})

describe('agentActivityLabel', () => {
  it('words idle as a turn ended, never as finished, and leaves out stopped agents', () => {
    expect(agentActivityLabel(activity({ waiting: 1, working: 2, idle: 1, exited: 3 }))).toBe(
      '1 waiting on you · 2 working · 1 turn ended'
    )
    expect(agentActivityLabel(activity({ ready: 1 }))).toBe('1 ready')
    expect(agentActivityLabel(undefined)).toBe('')
  })
})

describe('boardCounts', () => {
  it('lists the non-zero groups in Inbox order', () => {
    expect(boardCounts(summary({ needs: 2, next: 4 }))).toEqual([
      { group: 'needs', count: 2, label: '2 need you' },
      { group: 'next', count: 4, label: '4 up next' }
    ])
    expect(boardCounts(undefined)).toEqual([])
  })
})

describe('boardSummaryLabel', () => {
  it('spells Needs you out by why, then running and up next', () => {
    expect(
      boardSummaryLabel(summary({ needs: 4, waiting: 1, review: 2, spec: 1, running: 3, next: 4 }))
    ).toBe('1 waiting on you · 2 in review · 1 needs spec · 3 running · 4 up next')
    expect(boardSummaryLabel(summary({ needs: 2, spec: 2 }))).toBe('2 need spec')
  })

  it('says so when nothing is open, and is empty when the board could not be read', () => {
    expect(boardSummaryLabel(summary({}))).toBe('Nothing open')
    expect(boardSummaryLabel(undefined)).toBe('')
  })
})

describe('elsewhereNotice', () => {
  it('names the one workspace that needs you, so the pill can switch to it', () => {
    expect(
      elsewhereNotice(
        {
          activeId: 'default',
          byWorkspace: { a: activity({ waiting: 1, idle: 1 }, 1), p: activity({ working: 2 }) }
        },
        WORKSPACES
      )
    ).toEqual({
      text: '2 need you in Client A',
      label: '1 agent waiting in Client A · 1 ready for review in Client A · 2 working in Personal',
      targetId: 'a'
    })
  })

  it('counts the workspaces when several need you, and has no single target', () => {
    const notice = elsewhereNotice(
      {
        activeId: 'default',
        byWorkspace: { a: activity({ waiting: 1 }), p: activity({ idle: 1 }, 1) }
      },
      WORKSPACES
    )
    expect(notice?.text).toBe('2 need you in 2 workspaces')
    expect(notice?.targetId).toBeUndefined()
  })

  it('says "needs" for one, and shows nothing when agents are only working', () => {
    expect(
      elsewhereNotice(
        { activeId: 'default', byWorkspace: { p: activity({ waiting: 1 }) } },
        WORKSPACES
      )?.text
    ).toBe('1 needs you in Personal')
    expect(
      elsewhereNotice(
        { activeId: 'default', byWorkspace: { p: activity({ working: 3 }) } },
        WORKSPACES
      )
    ).toBeUndefined()
  })
})
