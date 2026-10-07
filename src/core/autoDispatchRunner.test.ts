import { describe, expect, it } from 'vitest'
import { shippedSettings } from './config.js'
import {
  createAutoDispatch,
  AUTO_DEBOUNCE_MS,
  AUTO_STARTUP_GRACE_MS
} from './autoDispatchRunner.js'
import { planOrchestration } from './orchestrate.js'
import type { Task } from './types.js'

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
  } = {}
) {
  let clock = 0
  let enabled = options.enabled ?? true
  let workspace = 'w'
  const timers: { at: number; run: () => void; id: number }[] = []
  let nextId = 0
  const launched: string[] = []
  const paused: string[] = []
  const states: unknown[] = []
  const notes: string[] = []
  const tasks = options.tasks ?? [task('A'), task('B', 1), task('C', 2)]
  const runner = createAutoDispatch({
    enabled: () => enabled,
    setEnabled: (on) => (enabled = on),
    workspaceId: () => workspace,
    snapshot: (skip) => ({
      plan: planOrchestration(shippedSettings(), tasks, {
        liveTaskIds: new Set(launched),
        agents: new Map(),
        skip
      }),
      tasks
    }),
    launch: async (t) => {
      if (options.failLaunch) throw new Error('boom')
      launched.push(t.id)
      options.onLaunch?.()
    },
    noteFailure: (t) => notes.push(t.id),
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
    timers,
    setEnabled: (on: boolean) => (enabled = on),
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
})
