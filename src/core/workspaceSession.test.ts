import { describe, expect, it } from 'vitest'
import type { AgentState, AgentStatus } from './agentState.js'
import type { Settings } from './types.js'
import {
  buildTrayModel,
  createWorkspaceSession,
  workspaceActivity,
  type WorkspaceSessionPorts
} from './workspaceSession.js'

const WORKSPACES = [
  { id: 'default', name: 'Default' },
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' }
]

function harness(active = 'default', folder = (id?: string) => `/store/${id ?? active}`) {
  const calls: string[] = []
  const state = { active }
  const ports: WorkspaceSessionPorts = {
    loadSettings: () => ({ activeWorkspaceId: state.active }) as Settings,
    listWorkspaces: () => WORKSPACES,
    workspaceDir: (_settings, id) => folder(id ?? state.active),
    saveActiveWorkspace: (_settings, id) => {
      calls.push(`save:${id}`)
      state.active = id
    },
    resetSources: () => calls.push('resetSources'),
    restartSourcePolling: () => calls.push('polling'),
    closeIndex: () => calls.push('closeIndex'),
    startTaskWatcher: () => calls.push('tasksWatcher'),
    startAgentWatcher: () => calls.push('agentsWatcher'),
    notifyTasks: () => calls.push('notifyTasks'),
    notifyAgents: () => calls.push('notifyAgents'),
    broadcast: (channel) => calls.push(`broadcast:${channel}`),
    hasLiveSessions: () => false,
    trash: async (path) => {
      calls.push(`trash:${path}`)
    }
  }
  return { calls, state, ports, session: createWorkspaceSession(ports) }
}

describe('switchWorkspace', () => {
  it('closes the index before restarting the watchers, then notifies and broadcasts', () => {
    const { calls, session } = harness()
    session.switchWorkspace('a')
    expect(calls).toEqual([
      'save:a',
      'resetSources',
      'polling',
      'closeIndex',
      'tasksWatcher',
      'agentsWatcher',
      'notifyTasks',
      'notifyAgents',
      'broadcast:settings:changed',
      'broadcast:workspaces:changed'
    ])
  })

  it('applies quick switches in order, each to completion', () => {
    const { calls, state, session } = harness()
    session.switchWorkspace('a')
    session.switchWorkspace('b')
    session.switchWorkspace('default')
    expect(calls.filter((call) => call.startsWith('save:'))).toEqual([
      'save:a',
      'save:b',
      'save:default'
    ])
    expect(calls.filter((call) => call === 'closeIndex')).toHaveLength(3)
    // Each save is followed by its whole repoint before the next save begins.
    const saves = calls.flatMap((call, i) => (call.startsWith('save:') ? [i] : []))
    expect(saves[1]! - saves[0]!).toBe(10)
    expect(saves[2]! - saves[1]!).toBe(10)
    expect(state.active).toBe('default')
  })

  it('does nothing when the workspace is already active', () => {
    const { calls, session } = harness('a')
    session.switchWorkspace('a')
    expect(calls).toEqual([])
  })

  it('refuses a workspace that no longer exists, before writing anything', () => {
    const { calls, session } = harness()
    expect(() => session.switchWorkspace('gone')).toThrow('no longer exists')
    expect(calls).toEqual([])
  })
})

describe('afterSettingsSave', () => {
  it('re-points when the storage folder changed', () => {
    const { calls, session } = harness('default', () => '/new')
    session.afterSettingsSave('/old', 'default')
    expect(calls).toEqual([
      'resetSources',
      'polling',
      'closeIndex',
      'tasksWatcher',
      'agentsWatcher',
      'notifyTasks',
      'notifyAgents',
      'polling',
      'broadcast:settings:changed'
    ])
  })

  it('only re-indexes when the saved workspace is the active one', () => {
    const same = harness()
    same.session.afterSettingsSave('/store/default', 'default')
    expect(same.calls).toEqual(['notifyTasks', 'polling', 'broadcast:settings:changed'])

    const other = harness()
    other.session.afterSettingsSave('/store/default', 'a')
    expect(other.calls).toEqual(['polling', 'broadcast:settings:changed'])
  })

  it('runs from a finally, so a failed save still re-points', () => {
    const { calls, session } = harness('default', () => '/new')
    const save = (): void => {
      throw new Error('disk full')
    }
    expect(() => {
      try {
        save()
      } finally {
        session.afterSettingsSave('/old', 'default')
      }
    }).toThrow('disk full')
    expect(calls).toContain('closeIndex')
    expect(calls.at(-1)).toBe('broadcast:settings:changed')
  })
})

describe('deleteWorkspace', () => {
  it('refuses Default, a missing workspace and one with live sessions', async () => {
    const { ports } = harness()
    await expect(createWorkspaceSession(ports).deleteWorkspace('default')).rejects.toThrow(
      'cannot be deleted'
    )
    await expect(createWorkspaceSession(ports).deleteWorkspace('gone')).rejects.toThrow(
      'no longer exists'
    )
    const busy = createWorkspaceSession({ ...ports, hasLiveSessions: () => true })
    await expect(busy.deleteWorkspace('a')).rejects.toThrow('terminal tabs')
  })

  it('switches off the active workspace before trashing it', async () => {
    const { calls, session } = harness('a')
    await session.deleteWorkspace('a')
    expect(calls.indexOf('save:default')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('save:default')).toBeLessThan(calls.indexOf('trash:/store/a'))
    expect(calls.slice(-3)).toEqual([
      'agentsWatcher',
      'notifyAgents',
      'broadcast:workspaces:changed'
    ])
  })

  it('leaves the active workspace alone when deleting another', async () => {
    const { calls, session } = harness('default')
    await session.deleteWorkspace('b')
    expect(calls).toEqual([
      'trash:/store/b',
      'agentsWatcher',
      'notifyAgents',
      'broadcast:workspaces:changed'
    ])
  })
})

describe('buildTrayModel', () => {
  const agent = (taskId: string, extra: Partial<AgentStatus> = {}): AgentStatus => ({
    taskId,
    state: 'working',
    at: '2026-01-01T00:00:00Z',
    ...extra
  })
  const task = (id: string, extra: object = {}) => ({
    id,
    title: `Title ${id}`,
    status: 'in_progress' as const,
    ...extra
  })
  const none = { statuses: [], titles: new Map<string, string>() }

  it('drops done, archived and unknown tasks', () => {
    const model = buildTrayModel(
      { activeWorkspaceId: 'default' },
      WORKSPACES.slice(0, 1),
      [agent('A'), agent('B'), agent('C'), agent('D')],
      [task('A'), task('B', { status: 'done' }), task('C', { archivedAt: '2026-01-01' })],
      none
    )
    expect(model.statuses.map((s) => s.taskId)).toEqual(['A'])
  })

  it('names the workspace only when there is more than one, but always tags it', () => {
    const single = buildTrayModel(
      { activeWorkspaceId: 'default' },
      WORKSPACES.slice(0, 1),
      [agent('A')],
      [task('A')],
      none
    )
    expect(single.statuses[0]).toMatchObject({ workspaceId: 'default' })
    expect(single.statuses[0]?.workspaceName).toBeUndefined()

    const several = buildTrayModel(
      { activeWorkspaceId: 'a' },
      WORKSPACES,
      [agent('A')],
      [task('A')],
      none
    )
    expect(several.statuses[0]).toMatchObject({ workspaceId: 'a', workspaceName: 'Alpha' })
  })

  it('titles by workspace-qualified key and appends background agents', () => {
    const bg = agent('Z', { workspaceId: 'b', workspaceName: 'Beta' })
    const model = buildTrayModel(
      { activeWorkspaceId: 'a' },
      WORKSPACES,
      [agent('A')],
      [task('A')],
      { statuses: [bg], titles: new Map([['b:Z', 'Background']]) }
    )
    expect(model.statuses.map((s) => s.taskId)).toEqual(['A', 'Z'])
    expect(model.titles.get('a:A')).toBe('Title A')
    expect(model.titles.get('b:Z')).toBe('Background')
  })

  it('marks idle agents on In Review tasks as awaiting review, with the background ones', () => {
    const model = buildTrayModel(
      { activeWorkspaceId: 'a' },
      WORKSPACES,
      [
        agent('A', { state: 'idle' }),
        agent('B', { state: 'working' }),
        agent('C', { state: 'idle' })
      ],
      [
        task('A', { status: 'in_review' }),
        task('B', { status: 'in_review' }),
        task('C', { status: 'in_review', readiness: 'needs_spec' })
      ],
      { statuses: [], titles: new Map(), awaitingReview: new Set(['b:Z']) }
    )
    expect([...model.awaitingReview].sort()).toEqual(['a:A', 'b:Z'])
  })
})

describe('workspaceActivity', () => {
  const at = '2026-01-01T00:00:00Z'
  const status = (workspaceId: string | undefined, taskId: string, state: AgentState) =>
    ({ workspaceId, taskId, state, at }) as AgentStatus
  const rollup = (statuses: AgentStatus[], awaitingReview: string[] = []) =>
    workspaceActivity({ statuses, awaitingReview: new Set(awaitingReview) })

  it('counts each workspace’s agents by state and picks the most urgent', () => {
    const activity = rollup([
      status('default', 'TASK-0001', 'working'),
      status('default', 'TASK-0002', 'waiting'),
      status('default', 'TASK-0003', 'idle'),
      status('a', 'TASK-0001', 'idle'),
      status('a', 'TASK-0002', 'ready')
    ])
    expect(activity.default).toEqual({
      counts: { ready: 0, working: 1, waiting: 1, idle: 1, exited: 0 },
      review: 0,
      top: 'waiting'
    })
    expect(activity.a?.top).toBe('ready')
    expect(activity.a?.counts.idle).toBe(1)
  })

  it('counts agents whose task awaits review, keyed by workspace and task', () => {
    const activity = rollup(
      [status('a', 'TASK-0001', 'idle'), status('b', 'TASK-0001', 'idle')],
      ['a:TASK-0001']
    )
    expect(activity.a?.review).toBe(1)
    expect(activity.b?.review).toBe(0)
  })

  it('never picks an exited agent as the top state', () => {
    const activity = rollup([
      status('a', 'TASK-0001', 'exited'),
      status('b', 'TASK-0001', 'exited'),
      status('b', 'TASK-0002', 'idle')
    ])
    expect(activity.a).toEqual({
      counts: { ready: 0, working: 0, waiting: 0, idle: 0, exited: 1 },
      review: 0
    })
    expect(activity.b?.top).toBe('idle')
  })

  it('skips untagged statuses and is empty without agents', () => {
    expect(rollup([status(undefined, 'TASK-0001', 'waiting')])).toEqual({})
    expect(rollup([])).toEqual({})
  })
})
