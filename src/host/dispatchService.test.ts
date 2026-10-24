import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shippedSettings } from '@core/config.js'
import type { AgentStatus } from '@core/agentState.js'
import { AUTO_DEBOUNCE_MS, AUTO_STARTUP_GRACE_MS } from '@core/autoDispatchRunner.js'
import type { LaunchOptions } from '@core/launch.js'
import type { Settings, Task, TerminalSessionInfo } from '@core/types.js'
import {
  createDispatchService,
  MERGED_WORK_WAIT_MS,
  realClock,
  type DispatchService,
  type DispatchServicePorts
} from './dispatchService.js'

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `Title of ${id}`,
    status: 'backlog',
    readiness: 'ready',
    priority: 'medium',
    order: Number(id.slice(-1)),
    createdAt: '2026-01-01T00:00:00Z',
    orchestrate: true,
    repoPath: '/repo',
    blockedBy: [],
    tags: [],
    sessions: [],
    activity: [],
    ...extra
  } as unknown as Task
}

const session = (taskId: string): TerminalSessionInfo =>
  ({ id: `s-${taskId}`, taskId, workspaceId: 'default' }) as unknown as TerminalSessionInfo

interface Harness {
  ports: DispatchServicePorts
  settings: Settings
  calls: string[]
  sent: { channel: string; payload: unknown }[]
  notes: string[]
  launches: { taskId: string; options: LaunchOptions }[]
  rows: Task[]
  sessions: TerminalSessionInfo[]
  statuses: AgentStatus[]
  /** What the next launch does; resolves with a session by default. */
  onLaunch: (taskId: string) => Promise<TerminalSessionInfo>
  /** What the merged-work check does; resolves at once by default. */
  merged: () => Promise<void>
}

function harness(): Harness {
  const h = {
    settings: { ...shippedSettings(), activeWorkspaceId: 'default' } as Settings,
    calls: [],
    sent: [],
    notes: [],
    launches: [],
    rows: [task('TASK-1'), task('TASK-2', { status: 'in_review' })],
    sessions: [],
    statuses: [],
    onLaunch: async (taskId: string) => session(taskId),
    merged: async () => {}
  } as unknown as Harness
  h.ports = {
    broadcast: (channel, payload) => {
      h.calls.push(`broadcast ${channel}`)
      h.sent.push({ channel, payload })
    },
    notify: (title, body) => h.calls.push(`notify ${title}: ${body}`),
    settings: {
      load: () => h.settings,
      saveWorkspace: (settings, workspaceId) => {
        h.calls.push(`save ${workspaceId} autoDispatch=${settings.autoDispatch}`)
        h.settings = settings
      }
    },
    tasks: {
      query: () => h.rows,
      addNote: (id, author, message) => h.notes.push(`${id} ${author}: ${message}`)
    },
    liveSessions: () => h.sessions,
    agentStatuses: () => h.statuses,
    launch: (taskId, options) => {
      h.calls.push(`launch ${taskId}`)
      h.launches.push({ taskId, options })
      return h.onLaunch(taskId)
    },
    checkForMergedWork: () => {
      h.calls.push('checkMerged')
      return h.merged()
    },
    clock: realClock
  }
  return h
}

let h: Harness
let service: DispatchService

beforeEach(() => {
  vi.useFakeTimers()
  h = harness()
  service = createDispatchService(h.ports)
})

afterEach(() => {
  vi.useRealTimers()
})

const autoState = () => h.sent.filter((s) => s.channel === 'orchestrate:autoState').at(-1)?.payload

describe('the plan', () => {
  it('summarises what Dispatch would start, with the provider each lane runs on', () => {
    h.settings = {
      ...h.settings,
      providerRouting: { ...h.settings.providerRouting, review: 'codex' }
    }
    const plan = service.plan()
    expect(plan.dispatch).toEqual([
      { taskId: 'TASK-1', title: 'Title of TASK-1', lane: 'implement', provider: 'claude' },
      { taskId: 'TASK-2', title: 'Title of TASK-2', lane: 'review', provider: 'codex' }
    ])
    expect(plan.reworkHeld).toEqual([])
    expect(plan).not.toHaveProperty('dispatch.0.task')
  })

  it('leaves out a task with an open tab in the active workspace, not one open in another', () => {
    h.sessions = [session('TASK-1'), { ...session('TASK-2'), workspaceId: 'other' }]
    expect(service.plan().dispatch.map((d) => d.taskId)).toEqual(['TASK-2'])
    expect(service.plan().idleSessions).toBe(1)
  })

  it('counts a working agent against its lane', () => {
    h.rows = [...h.rows, task('TASK-3', { status: 'in_review' })]
    h.statuses = [{ taskId: 'TASK-3', state: 'working', at: '' } as AgentStatus]
    // TASK-3 is In Review with no tab open, so it is a candidate, but the review lane is full.
    const plan = service.plan()
    expect(plan.occupied.review).toBe(1)
    expect(plan.dispatch.map((d) => d.lane)).toEqual(['implement'])
  })
})

describe('Dispatch now', () => {
  it('checks for merged work, then starts every planned task with its lane options', async () => {
    const result = await service.run()
    expect(h.calls).toEqual(['checkMerged', 'launch TASK-1', 'launch TASK-2'])
    expect(h.launches).toEqual([
      { taskId: 'TASK-1', options: { withPrompt: true, fresh: false, provider: 'claude' } },
      { taskId: 'TASK-2', options: { withPrompt: true, fresh: true, provider: 'claude' } }
    ])
    expect(result).toEqual([
      { lane: 'implement', taskId: 'TASK-1', session: session('TASK-1') },
      { lane: 'review', taskId: 'TASK-2', session: session('TASK-2') }
    ])
  })

  it('starts only the tasks asked for', async () => {
    const result = await service.run(['TASK-2'])
    expect(result.map((r) => r.taskId)).toEqual(['TASK-2'])
  })

  it('launches in the order asked for, ignoring unknown ids, and returns results in that order', async () => {
    const result = await service.run(['TASK-2', 'NOPE', 'TASK-1'])
    expect(h.launches.map((l) => l.taskId)).toEqual(['TASK-2', 'TASK-1'])
    expect(result.map((r) => r.taskId)).toEqual(['TASK-2', 'TASK-1'])
  })

  it('plans after the check: a review merged meanwhile is not started', async () => {
    h.merged = async () => {
      h.rows = [task('TASK-1'), task('TASK-2', { status: 'done' })]
    }
    expect((await service.run()).map((r) => r.taskId)).toEqual(['TASK-1'])
  })

  it('goes ahead without the check when the remote is slow', async () => {
    h.merged = () => new Promise(() => {})
    const run = service.run()
    await vi.advanceTimersByTimeAsync(MERGED_WORK_WAIT_MS - 1)
    expect(h.launches).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect((await run).map((r) => r.taskId)).toEqual(['TASK-1', 'TASK-2'])
  })

  it('does not tell the renderer about sessions it asked for itself', async () => {
    await service.run()
    expect(h.sent.map((s) => s.channel)).not.toContain('orchestrate:autoStarted')
  })
})

describe('Auto-run', () => {
  it('turning it on writes the flag, broadcasts the settings and the state, then runs a pass', async () => {
    expect(service.autoSet(true)).toEqual({ on: true })
    expect(h.calls).toEqual([
      'save default autoDispatch=true',
      'broadcast settings:changed',
      'broadcast orchestrate:autoState'
    ])
    expect(autoState()).toEqual({ on: true })
    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)
    expect(h.calls.slice(3)).toEqual([
      'checkMerged',
      'launch TASK-1',
      'broadcast orchestrate:autoStarted',
      'launch TASK-2',
      'broadcast orchestrate:autoStarted'
    ])
    const started = h.sent.filter((s) => s.channel === 'orchestrate:autoStarted')
    expect(started.map((s) => s.payload)).toEqual([session('TASK-1'), session('TASK-2')])
  })

  it('marks its launches with their lane, which Dispatch now does not', async () => {
    service.autoSet(true)
    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)
    expect(h.launches.map((l) => l.options.dispatchLane)).toEqual(['implement', 'review'])
    h.launches = []
    await service.run()
    expect(h.launches.map((l) => l.options.dispatchLane)).toEqual([undefined, undefined])
  })

  it('switching it on stamps when, which a Stop leaves alone', () => {
    vi.setSystemTime(new Date('2026-03-04T05:06:07Z'))
    service.autoSet(true)
    expect(h.settings.autoDispatchSince).toBe('2026-03-04T05:06:07.000Z')
    vi.setSystemTime(new Date('2026-03-05T00:00:00Z'))
    service.autoSet(false)
    expect(h.settings.autoDispatchSince).toBe('2026-03-04T05:06:07.000Z')
  })

  it('rejects a flag that is not a boolean', () => {
    expect(() => service.autoSet('yes')).toThrow()
    expect(h.calls).toEqual([])
  })

  it('a burst of requests is one pass, and starts nothing it already started', async () => {
    service.autoSet(true)
    for (let i = 0; i < 5; i += 1) service.requestAutoRun()
    await vi.advanceTimersByTimeAsync(10_000)
    service.requestAutoRun()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.calls.filter((c) => c === 'checkMerged')).toHaveLength(2)
    expect(h.launches.map((l) => l.taskId)).toEqual(['TASK-1', 'TASK-2'])
  })

  it('does nothing on a request while it is off', async () => {
    service.requestAutoRun()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.calls).toEqual([])
  })

  it('waits out the startup grace before its first pass', async () => {
    h.settings = { ...h.settings, autoDispatch: true }
    service.startAutoRun()
    expect(autoState()).toEqual({ on: true })
    await vi.advanceTimersByTimeAsync(AUTO_STARTUP_GRACE_MS - 1)
    expect(h.launches).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.launches.map((l) => l.taskId)).toEqual(['TASK-1', 'TASK-2'])
  })

  it('Stop mid-pass starts nothing further and leaves running agents alone', async () => {
    service.autoSet(true)
    h.onLaunch = async (taskId) => {
      expect(service.autoSet(false)).toEqual({ on: false })
      return session(taskId)
    }
    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)
    expect(h.launches.map((l) => l.taskId)).toEqual(['TASK-1'])
    expect(h.calls).toContain('save default autoDispatch=false')
    expect(h.calls.filter((c) => c.startsWith('notify'))).toEqual([])
    expect(autoState()).toEqual({ on: false })
    expect(service.autoState()).toEqual({ on: false })
  })

  it('switches itself off after three failed launches, notes each task and notifies once', async () => {
    h.rows = [task('TASK-1'), task('TASK-2'), task('TASK-3', { readiness: 'needs_spec' })]
    h.onLaunch = async () => {
      throw new Error('no CLI')
    }
    service.autoSet(true)
    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)
    expect(h.launches).toHaveLength(3)
    expect(h.notes).toEqual(
      ['TASK-1', 'TASK-2', 'TASK-3'].map(
        (id) => `${id} styr: Auto-run could not start this task: no CLI`
      )
    )
    const tail = h.calls.slice(h.calls.indexOf('launch TASK-3') + 1)
    expect(tail).toEqual([
      'save default autoDispatch=false',
      'broadcast settings:changed',
      'notify Styr: Auto-run switched itself off after three launches in a row failed.',
      'broadcast orchestrate:autoState'
    ])
    expect(autoState()).toEqual({ on: false, paused: 'failures' })
    expect(h.sent.map((s) => s.channel)).not.toContain('orchestrate:autoStarted')
  })

  it('a settings save that turns it back on clears the pause', async () => {
    h.rows = [task('TASK-1'), task('TASK-2'), task('TASK-3', { readiness: 'needs_spec' })]
    h.onLaunch = async () => {
      throw new Error('no CLI')
    }
    service.autoSet(true)
    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)
    expect(service.autoState()).toEqual({ on: false, paused: 'failures' })
    h.settings = { ...h.settings, autoDispatch: true }
    service.autoRunFlagChanged()
    expect(service.autoState()).toEqual({ on: true })
  })

  it('a note that cannot be written does not stop the pass', async () => {
    h.ports.tasks.addNote = () => {
      throw new Error('task deleted')
    }
    h.onLaunch = async (taskId) => {
      if (taskId === 'TASK-1') throw new Error('no CLI')
      return session(taskId)
    }
    service.autoSet(true)
    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)
    expect(h.launches.map((l) => l.taskId)).toEqual(['TASK-1', 'TASK-2'])
    expect(autoState()).toEqual({ on: true })
  })
})
