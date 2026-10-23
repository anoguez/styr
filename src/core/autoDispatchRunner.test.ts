import { describe, expect, it } from 'vitest'
import { shippedSettings } from './config.js'
import {
  createAutoDispatch,
  AUTO_DEBOUNCE_MS,
  AUTO_STARTUP_GRACE_MS
} from './autoDispatchRunner.js'
import { reworkCappedMessage } from './autoDispatch.js'
import { planOrchestration } from './orchestrate.js'
import { launchPatch } from './sessionLifecycle.js'
import type { AgentState, Task, TaskSessionRef } from './types.js'

function task(id: string, order = 0): Task {
  return {
    id,
    title: id,
    description: '',
    status: 'backlog',
    priority: 'medium',
    readiness: 'ready',
    tags: [],
    blockedBy: [],
    contextFiles: [],
    orchestrate: true,
    repoPath: '/repo',
    filePath: `/tasks/${id}.md`,
    sessions: [],
    activity: [],
    order,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  } as unknown as Task
}

function setup(
  options: {
    tasks?: Task[]
    enabled?: boolean
    failLaunch?: boolean
    onLaunch?: () => void
    beforePass?: () => void
    /** Sessions end as soon as they start, so a task can be started again. */
    sessionsEnd?: boolean
    /** Agent state of every task launched so far (a fresh launch is `ready`, never `working`). */
    launchedState?: AgentState
    /**
     * Launches and capped notes are written to the tasks as the real ports write them to the
     * files, so a second runner can be built over the same tasks.
     */
    writeFiles?: boolean
    /** `Settings.autoDispatchSince`. */
    since?: string
    clock?: number
  } = {}
) {
  let clock = options.clock ?? 0
  let since = options.since
  let enabled = options.enabled ?? true
  let workspace = 'w'
  const timers: { at: number; run: () => void; id: number }[] = []
  let nextId = 0
  const launched: string[] = []
  const paused: string[] = []
  const states: unknown[] = []
  const notes: string[] = []
  const capped: string[] = []
  const calls: string[] = []
  const tasks = options.tasks ?? [task('A'), task('B', 1), task('C', 2)]
  const runner = createAutoDispatch({
    enabled: () => enabled,
    setEnabled: (on) => (enabled = on),
    workspaceId: () => workspace,
    since: () => since,
    beforePass: async () => {
      calls.push('beforePass')
      options.beforePass?.()
    },
    snapshot: (skip) => ({
      plan: planOrchestration(shippedSettings(), tasks, {
        liveTaskIds: new Set(options.sessionsEnd ? [] : launched),
        agents: new Map(
          options.launchedState ? launched.map((id) => [id, options.launchedState!]) : []
        ),
        skip
      }),
      tasks
    }),
    launch: async (t, lane) => {
      if (options.failLaunch) throw new Error('boom')
      calls.push(`launch ${t.id} ${lane}`)
      launched.push(t.id)
      if (options.writeFiles) {
        // Reviews start fresh; a rework resumes the one implementer chat.
        const sessionId = lane === 'review' ? `${t.id}-review-${calls.length}` : `${t.id}-implement`
        const at = () => new Date(clock).toISOString()
        Object.assign(
          t,
          launchPatch(
            shippedSettings(),
            t,
            { provider: 'claude' },
            { sessionId, dispatchLane: lane },
            at
          )
        )
      }
      options.onLaunch?.()
    },
    noteFailure: (t) => notes.push(t.id),
    reworkCapped: (t) => {
      capped.push(t.id)
      if (options.writeFiles) {
        const note = {
          at: new Date(clock).toISOString(),
          author: 'styr',
          message: reworkCappedMessage(t.id)
        }
        t.activity = [...t.activity, note]
      }
    },
    paused: (reason) => paused.push(reason),
    stateChanged: (state) => states.push(state),
    now: () => clock,
    setTimer: (run, ms) => {
      const id = nextId++
      timers.push({ at: clock + ms, run, id })
      return id
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((t) => t.id === handle)
      if (index >= 0) timers.splice(index, 1)
    }
  })
  async function advance(ms: number): Promise<void> {
    clock += ms
    for (;;) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers.splice(timers.indexOf(due), 1)
      due.run()
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  return {
    runner,
    advance,
    launched,
    paused,
    states,
    notes,
    capped,
    calls,
    tasks,
    timers,
    setEnabled: (on: boolean) => (enabled = on),
    /** Switching Auto-run on as `orchestrate:autoSet` does: stamp `autoDispatchSince`, then tell it. */
    switchOn: () => {
      enabled = true
      since = new Date(clock).toISOString()
      runner.enabledChanged()
    },
    setWorkspace: (id: string) => (workspace = id)
  }
}

describe('createAutoDispatch', () => {
  it('does nothing and arms no timer while off', () => {
    const t = setup({ enabled: false })
    t.runner.request()
    expect(t.timers).toHaveLength(0)
  })

  it('coalesces a burst of events into one pass', async () => {
    const t = setup()
    for (let i = 0; i < 50; i += 1) t.runner.request()
    expect(t.timers).toHaveLength(1)
    await t.advance(AUTO_DEBOUNCE_MS)
    // Implementation capacity is 2 in the shipped settings.
    expect(t.launched).toEqual(['A', 'B'])
  })

  it('waits out the startup grace before the first pass', async () => {
    const t = setup()
    t.runner.start()
    await t.advance(AUTO_DEBOUNCE_MS)
    expect(t.launched).toEqual([])
    await t.advance(AUTO_STARTUP_GRACE_MS)
    expect(t.launched).toEqual(['A', 'B'])
  })

  it('a toggle on skips the grace', async () => {
    const t = setup({ enabled: false })
    t.runner.start()
    t.setEnabled(true)
    t.runner.enabledChanged()
    await t.advance(AUTO_DEBOUNCE_MS)
    expect(t.launched).toEqual(['A', 'B'])
  })

  it('Stop cancels the pending pass and starts nothing', async () => {
    const t = setup()
    t.runner.request()
    t.setEnabled(false)
    t.runner.enabledChanged()
    expect(t.timers).toHaveLength(0)
    await t.advance(AUTO_DEBOUNCE_MS * 2)
    expect(t.launched).toEqual([])
    expect(t.runner.state()).toEqual({ on: false })
  })

  it('a workspace switch mid-pass starts nothing further', async () => {
    const t = setup({ onLaunch: () => t.setWorkspace('other') })
    t.runner.request()
    await t.advance(AUTO_DEBOUNCE_MS)
    expect(t.launched).toEqual(['A'])
  })

  it('turns itself off after repeated launch failures, noting each task', async () => {
    const t = setup({ failLaunch: true })
    t.runner.request()
    await t.advance(AUTO_DEBOUNCE_MS)
    t.runner.request()
    await t.advance(AUTO_DEBOUNCE_MS)
    expect(t.notes).toEqual(['A', 'B', 'C'])
    expect(t.paused).toEqual(['failures'])
    expect(t.runner.state()).toEqual({ on: false, paused: 'failures' })
  })

  it('turning it back on clears the pause', async () => {
    const t = setup({ failLaunch: true })
    t.runner.request()
    await t.advance(AUTO_DEBOUNCE_MS)
    t.runner.request()
    await t.advance(AUTO_DEBOUNCE_MS)
    t.setEnabled(true)
    t.runner.enabledChanged()
    expect(t.runner.state()).toEqual({ on: true })
  })

  it('runs the merged-work check before reading the board, so what it unblocks starts', async () => {
    const review = { ...task('A'), status: 'in_review' } as Task
    const dependent = { ...task('B', 1), blockedBy: ['A'] } as Task
    const t = setup({
      tasks: [review, dependent],
      beforePass: () => (review.status = 'done')
    })
    t.runner.request()
    await t.advance(AUTO_DEBOUNCE_MS)
    expect(t.calls).toEqual(['beforePass', 'launch B implement'])
  })

  /** One pass, as a write to the board would trigger it. */
  async function pass(t: ReturnType<typeof setup>): Promise<void> {
    t.runner.request()
    await t.advance(AUTO_DEBOUNCE_MS)
  }

  /** Auto-run reviews A three times, and each review sends it back to Backlog. */
  async function failThreeReviews(t: ReturnType<typeof setup>, a: Task): Promise<void> {
    for (let round = 0; round < 3; round += 1) {
      await pass(t)
      a.status = 'backlog' // the reviewer asked for fixes
      await pass(t)
      if (round < 2) a.status = 'in_review' // the implementer finished again
    }
  }

  it('stops starting a task after three failed reviews, notifies once, and a toggle on resets it', async () => {
    const a = { ...task('A'), status: 'in_review' } as Task
    const t = setup({ tasks: [a], sessionsEnd: true, writeFiles: true, clock: 1_000 })
    await failThreeReviews(t, a)
    expect(t.calls.filter((call) => call === 'launch A review')).toHaveLength(3)
    expect(t.calls.filter((call) => call === 'launch A implement')).toHaveLength(2)
    expect(t.capped).toEqual(['A'])
    expect(t.runner.held()).toEqual(new Set(['A']))

    const before = t.calls.length
    await pass(t)
    expect(t.calls.slice(before).filter((call) => call.startsWith('launch'))).toEqual([])
    expect(t.capped).toEqual(['A'])

    await t.advance(1)
    t.switchOn()
    await t.advance(AUTO_DEBOUNCE_MS)
    expect(t.calls.at(-1)).toBe('launch A implement')
    expect(t.runner.held()).toEqual(new Set())
  })

  it('a new runner over the same files keeps a capped task held and does not notify again', async () => {
    const a = { ...task('A'), status: 'in_review' } as Task
    const first = setup({ tasks: [a], sessionsEnd: true, writeFiles: true, clock: 1_000 })
    await failThreeReviews(first, a)
    expect(first.capped).toEqual(['A'])

    // A relaunch: nothing survives but the task file.
    const second = setup({ tasks: [a], sessionsEnd: true, clock: 5_000 })
    await pass(second)
    expect(second.launched).toEqual([])
    expect(second.runner.held()).toEqual(new Set(['A']))
    expect(second.capped).toEqual([])
  })

  it('a new runner notifies a cap reached while nothing was running, once', async () => {
    const at = (ms: number) => new Date(ms).toISOString()
    const review = (id: string, ms: number, sentBack?: true): TaskSessionRef => ({
      id,
      provider: 'claude',
      startedAt: at(ms),
      label: 'Review the work',
      templateId: 'code-review',
      dispatch: 'review',
      ...(sentBack ? { sentBack } : {})
    })
    const a = {
      ...task('A'),
      agentSession: { provider: 'claude', id: 'r3' },
      sessions: [review('r1', 1, true), review('r2', 2, true), review('r3', 3)]
    } as Task
    const t = setup({ tasks: [a], writeFiles: true, clock: 10 })
    await pass(t)
    await pass(t)
    expect(t.capped).toEqual(['A'])
    expect(t.launched).toEqual([])
    const again = setup({ tasks: [a], clock: 20 })
    await pass(again)
    expect(again.capped).toEqual([])
  })

  it('a new runner does not start again a review Auto-run already ran on this state', async () => {
    const a = { ...task('A'), status: 'in_review' } as Task
    const first = setup({ tasks: [a], sessionsEnd: true, writeFiles: true })
    await pass(first)
    expect(first.launched).toEqual(['A']) // the review passed and left A In Review

    const second = setup({ tasks: [a, task('B', 1)], sessionsEnd: true })
    await pass(second)
    expect(second.launched).toEqual(['B'])
  })

  it("a new runner counts the past hour's launches against the limit", async () => {
    const hour = 60 * 60 * 1000
    const started = (index: number, ms: number): Task =>
      ({
        ...task(`D${index}`),
        status: 'in_progress',
        sessions: [
          {
            id: `s${index}`,
            provider: 'claude',
            startedAt: new Date(ms).toISOString(),
            label: 'Implement the task',
            dispatch: 'implement'
          }
        ]
      }) as Task
    const now = 3 * hour
    const recent = Array.from({ length: 20 }, (_, i) => started(i, now - hour + 1_000 + i))
    const t = setup({ tasks: [...recent, task('A')], clock: now })
    await pass(t)
    expect(t.launched).toEqual([])
    expect(t.paused).toEqual(['limit'])

    const older = Array.from({ length: 20 }, (_, i) => started(i, now - hour - 1_000))
    const fresh = setup({ tasks: [...older, task('A')], clock: now })
    await pass(fresh)
    expect(fresh.launched).toEqual(['A'])
  })

  it('never launches past a lane limit while launched agents are still ready', async () => {
    const t = setup({
      tasks: [task('A'), task('B', 1), task('C', 2), task('D', 3), task('E', 4)],
      sessionsEnd: true,
      launchedState: 'ready'
    })
    for (let i = 0; i < 5; i += 1) {
      t.runner.request()
      await t.advance(AUTO_DEBOUNCE_MS)
    }
    // Implementation capacity is 2 in the shipped settings.
    expect(t.launched).toEqual(['A', 'B'])
  })
})
