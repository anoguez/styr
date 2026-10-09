import { describe, expect, it } from 'vitest'
import type { OrchestrationSummary } from '@core/types.js'
import { dispatchButton, isDispatchLive, orchestrateHint } from './orchestrateHint.js'

const lanes = (n: number): OrchestrationSummary['capacity'] => ({
  spec: n,
  implement: n,
  review: n
})

const summary = (over: Partial<OrchestrationSummary> = {}): OrchestrationSummary => ({
  dispatch: [],
  occupied: lanes(0),
  capacity: lanes(2),
  eligible: lanes(0),
  optedOut: 0,
  blocked: 0,
  missingWorkingDir: 0,
  idleSessions: 0,
  ...over
})

describe('orchestrateHint', () => {
  it('is plain before the plan loads', () => {
    expect(orchestrateHint(null)).toBe('Dispatch')
  })

  it('lists what would start', () => {
    const hint = orchestrateHint(
      summary({
        dispatch: [
          { taskId: 'TASK-0001', title: 'a', lane: 'spec', provider: 'claude' },
          { taskId: 'TASK-0002', title: 'b', lane: 'review', provider: 'codex' }
        ]
      })
    )
    expect(hint).toBe('Start 2: TASK-0001 (spec), TASK-0002 (review)')
  })

  it('names lanes with no free slot', () => {
    const hint = orchestrateHint(summary({ occupied: { ...lanes(0), implement: 2 } }))
    expect(hint).toBe('No free slots in: implement')
  })

  it('ignores a lane with zero capacity', () => {
    expect(orchestrateHint(summary({ capacity: lanes(0) }))).toBe('Nothing ready to start')
  })

  it('explains why nothing starts', () => {
    const hint = orchestrateHint(summary({ idleSessions: 1, optedOut: 2, missingWorkingDir: 3 }))
    expect(hint).toBe(
      'Nothing to start — 1 already have a terminal tab open — close it to hand the task back, 2 opted out, 3 without a working directory'
    )
  })

  it('falls back when there is nothing to say', () => {
    expect(orchestrateHint(summary())).toBe('Nothing ready to start')
  })
})

describe('dispatchButton', () => {
  const entry = {
    taskId: 'TASK-0001',
    title: 't',
    lane: 'implement' as const,
    provider: 'claude' as const
  }

  it('is plain Dispatch with the waiting count when Auto-run is off', () => {
    const button = dispatchButton(summary({ dispatch: [entry] }), { on: false }, false)
    expect(button).toMatchObject({ mode: 'idle', label: 'Dispatch', badge: 1 })
  })

  it('shows a manual run in progress', () => {
    expect(dispatchButton(summary(), { on: false }, true).mode).toBe('dispatching')
  })

  it('becomes Auto-run with the running count when it is on', () => {
    const occupied = { spec: 1, implement: 2, review: 0 }
    const button = dispatchButton(summary({ occupied, dispatch: [entry] }), { on: true }, true)
    expect(button).toMatchObject({ mode: 'auto', label: 'Auto-run', badge: 3 })
  })

  it('says when the breaker paused Auto-run', () => {
    const button = dispatchButton(summary(), { on: false, paused: 'limit' }, false)
    expect(button.mode).toBe('paused')
    expect(button.title).toMatch(/too many tasks/)
  })
})

describe('isDispatchLive', () => {
  it('is live during a manual run and while Auto-run is on', () => {
    expect(isDispatchLive({ mode: 'dispatching' })).toBe(true)
    expect(isDispatchLive({ mode: 'auto' })).toBe(true)
    expect(isDispatchLive({ mode: 'idle' })).toBe(false)
    expect(isDispatchLive({ mode: 'paused' })).toBe(false)
  })
})
