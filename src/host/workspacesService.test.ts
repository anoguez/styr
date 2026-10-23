import { beforeEach, describe, expect, it } from 'vitest'
import { pinnedWorkspaceId, shippedSettings } from '@core/config.js'
import type { AgentStatus } from '@core/agentState.js'
import type { Settings, Task, WorkspaceInfo } from '@core/types.js'
import {
  createWorkspacesService,
  inOtherWorkspace,
  type WorkspacesService,
  type WorkspacesServicePorts
} from './workspacesService.js'

interface Harness {
  ports: WorkspacesServicePorts
  calls: string[]
  settings: Settings
  workspaces: WorkspaceInfo[]
  sessions: { workspaceId?: string }[]
  /** Background workspaces' task files, by workspace id. */
  files: Map<string, Task[]>
  broken: Set<string>
}

const task = (id: string, extra: Partial<Task> = {}): Task =>
  ({
    id,
    title: id,
    status: 'backlog',
    readiness: 'ready',
    tags: [],
    blockedBy: [],
    activity: [],
    order: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra
  }) as Task

function harness(): Harness {
  const calls: string[] = []
  const log = (entry: string) => (): void => {
    calls.push(entry)
  }
  const h = {
    calls,
    settings: { ...shippedSettings(), activeWorkspaceId: 'default' } as Settings,
    workspaces: [
      { id: 'default', name: 'Default' },
      { id: 'alpha', name: 'Alpha' }
    ] as WorkspaceInfo[],
    sessions: [],
    files: new Map([['alpha', [task('TASK-0001'), task('TASK-0002')]]]),
    broken: new Set<string>()
  } as unknown as Harness
  h.ports = {
    broadcast: (channel) => calls.push(`broadcast ${channel}`),
    trashItem: async (path) => void calls.push(`trash ${path}`),
    store: {
      loadSettings: () => h.settings,
      saveActiveWorkspace: (_settings, id) => {
        calls.push(`saveActive ${id}`)
        h.settings = { ...h.settings, activeWorkspaceId: id }
      },
      listWorkspaces: () => h.workspaces,
      createWorkspace: (settings, name, seed) => {
        calls.push(
          `create ${name} autoDispatch=${seed.autoDispatch} since=${seed.autoDispatchSince}`
        )
        const created = { id: name.toLowerCase(), name } as WorkspaceInfo
        h.workspaces = [...h.workspaces, created]
        return created
      },
      renameWorkspace: (_settings, id, name) => {
        calls.push(`rename ${id} ${name}`)
        return { id, name } as WorkspaceInfo
      },
      workspaceDir: (_settings, id = h.settings.activeWorkspaceId) => `/storage/${id}`,
      workspaceTaskCount: (_settings, id) => h.files.get(id)?.length ?? 0,
      readWorkspaceTasks: (_settings, id) => {
        if (id === 'unreadable') throw new Error('EACCES')
        return h.files.get(id) ?? []
      },
      readAgentStatuses: () => [] as AgentStatus[],
      isSettingsFileBroken: (_settings, id) => h.broken.has(id),
      settingsFilePath: (_settings, id) => `/storage/${id}/settings.json`
    },
    activeTasks: () => [task('TASK-0001')],
    liveSessions: () => h.sessions,
    activity: () => ({ activeId: h.settings.activeWorkspaceId, byWorkspace: {} }),
    resetSources: log('resetSources'),
    restartSourcePolling: log('restartSourcePolling'),
    closeIndex: log('closeIndex'),
    startTaskWatcher: log('startTaskWatcher'),
    startAgentWatcher: log('startAgentWatcher'),
    notifyTasks: log('notifyTasks'),
    notifyAgents: log('notifyAgents')
  }
  return h
}

let h: Harness
let service: WorkspacesService

beforeEach(() => {
  h = harness()
  service = createWorkspacesService(h.ports)
})

/** What a switch repoints, in the order `core/workspaceSession.ts` holds. */
const REPOINT = [
  'resetSources',
  'restartSourcePolling',
  'closeIndex',
  'startTaskWatcher',
  'startAgentWatcher',
  'notifyTasks',
  'notifyAgents'
]

describe('switch', () => {
  it('saves the choice, repoints the index and watchers, then broadcasts, all synchronously', () => {
    const overview = service.switch('alpha')
    expect(h.calls).toEqual([
      'saveActive alpha',
      ...REPOINT,
      'broadcast settings:changed',
      'broadcast workspaces:changed'
    ])
    expect(overview.activeId).toBe('alpha')
  })

  it('refuses a workspace that no longer exists, touching nothing', () => {
    expect(() => service.switch('gone')).toThrow('no longer exists')
    expect(h.calls).toEqual([])
  })
})

describe('create, rename and delete', () => {
  it('creates with Auto-run off and switches to the new workspace', () => {
    h.settings = { ...h.settings, autoDispatch: true, autoDispatchSince: '2026-01-01T00:00:00Z' }
    const overview = service.create('Beta')
    expect(h.calls[0]).toBe('create Beta autoDispatch=false since=undefined')
    expect(h.calls).toContain('saveActive beta')
    expect(overview.activeId).toBe('beta')
  })

  it('renames, then refreshes the agents (the menu bar names workspaces) and the switcher', () => {
    service.rename('alpha', 'Renamed')
    expect(h.calls).toEqual([
      'rename alpha Renamed',
      'notifyAgents',
      'broadcast workspaces:changed'
    ])
  })

  it('refuses to delete a workspace with live terminals', async () => {
    h.sessions = [{ workspaceId: 'alpha' }]
    await expect(service.delete('alpha')).rejects.toThrow('terminal tabs')
    expect(h.calls).toEqual([])
  })

  it('deleting the active workspace switches to Default first, then trashes its folder', async () => {
    h.settings = { ...h.settings, activeWorkspaceId: 'alpha' }
    await service.delete('alpha')
    expect(h.calls).toEqual([
      'saveActive default',
      ...REPOINT,
      'broadcast settings:changed',
      'broadcast workspaces:changed',
      'trash /storage/alpha',
      'startAgentWatcher',
      'notifyAgents',
      'broadcast workspaces:changed'
    ])
  })
})

describe('summaries', () => {
  it('counts each workspace’s tasks and live terminals', () => {
    h.sessions = [{ workspaceId: 'alpha' }, { workspaceId: 'alpha' }, {}]
    expect(service.overview()).toEqual({
      activeId: 'default',
      workspaces: [
        { id: 'default', name: 'Default', taskCount: 0, liveSessions: 0 },
        { id: 'alpha', name: 'Alpha', taskCount: 2, liveSessions: 2 }
      ]
    })
  })

  it('summarises the active board from the index and the others from their files', () => {
    const summaries = service.boardSummaries()
    expect(summaries.default?.next).toBe(1)
    expect(summaries.alpha?.next).toBe(2)
  })

  it('leaves out a workspace that cannot be read', () => {
    h.workspaces = [...h.workspaces, { id: 'unreadable', name: 'Unreadable' } as WorkspaceInfo]
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void errors.push(args)
    try {
      expect(Object.keys(service.boardSummaries())).toEqual(['default', 'alpha'])
    } finally {
      console.error = original
    }
    expect(errors).toHaveLength(1)
  })

  it('names the settings files that do not parse', () => {
    h.broken.add('alpha')
    expect(service.brokenSettingsFiles()).toEqual([
      { workspaceId: 'alpha', path: '/storage/alpha/settings.json' }
    ])
  })
})

describe('afterSettingsSave', () => {
  it('repoints when the storage folder moved', () => {
    service.afterSettingsSave('/elsewhere/default', 'default')
    expect(h.calls).toEqual([...REPOINT, 'restartSourcePolling', 'broadcast settings:changed'])
  })

  it('only re-indexes when the active workspace’s own settings changed', () => {
    service.afterSettingsSave('/storage/default', 'default')
    expect(h.calls).toEqual(['notifyTasks', 'restartSourcePolling', 'broadcast settings:changed'])
  })
})

describe('inOtherWorkspace', () => {
  it('pins the workspace only while the work runs, and clears it on a throw', () => {
    expect(inOtherWorkspace('alpha', () => pinnedWorkspaceId())).toBe('alpha')
    expect(pinnedWorkspaceId()).toBeUndefined()
    expect(() =>
      inOtherWorkspace('alpha', () => {
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(pinnedWorkspaceId()).toBeUndefined()
  })

  it('never holds the pin across an await', async () => {
    let afterAwait: string | undefined = 'unset'
    const pending = inOtherWorkspace('alpha', async () => {
      await Promise.resolve()
      afterAwait = pinnedWorkspaceId()
    })
    expect(pinnedWorkspaceId()).toBeUndefined()
    await pending
    expect(afterAwait).toBeUndefined()
  })
})
