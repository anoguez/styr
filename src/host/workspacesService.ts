import { pinWorkspace, pathsInWorkspace, workspaceDir } from '@core/config.js'
import { readAllAgentStatuses } from '@core/agentStore.js'
import { buildInbox, summariseInbox } from '@core/inbox.js'
import {
  isSettingsFileBroken,
  loadSettings,
  saveGlobalSettings,
  settingsFilePath
} from '@core/settingsStore.js'
import {
  globalSettingsFor,
  workspaceSettingsFor,
  type BrokenSettingsFile,
  type Settings,
  type Task,
  type WorkspaceBoardSummary,
  type WorkspaceOverview,
  type WorkspacesActivity
} from '@core/types.js'
import { createWorkspaceSession } from '@core/workspaceSession.js'
import {
  createWorkspace,
  listWorkspaces,
  readWorkspaceTasks,
  renameWorkspace,
  workspaceTaskCount
} from '@core/workspaces.js'
import type { AgentStatus } from '@core/agentState.js'
import type { HostPorts } from './ports.js'

/**
 * Runs `work` with every task path resolved inside another workspace. Synchronous on purpose:
 * nothing else can observe the override while it is set, and an `await` inside `work` resumes
 * unpinned.
 */
export function inOtherWorkspace<T>(workspaceId: string, work: () => T): T {
  pinWorkspace(workspaceId)
  try {
    return work()
  } finally {
    pinWorkspace(undefined)
  }
}

/** The workspace folders on disk, from `core/`. A test swaps it for an in-memory one. */
export interface WorkspaceStore {
  loadSettings(): Settings
  saveActiveWorkspace(settings: Settings, id: string): void
  listWorkspaces: typeof listWorkspaces
  createWorkspace: typeof createWorkspace
  renameWorkspace: typeof renameWorkspace
  workspaceDir: typeof workspaceDir
  workspaceTaskCount: typeof workspaceTaskCount
  /** A background workspace's tasks, parsed from its files without writing. */
  readWorkspaceTasks: typeof readWorkspaceTasks
  /** The agent records of the workspace `settings` is scoped to. */
  readAgentStatuses(settings: Settings): AgentStatus[]
  isSettingsFileBroken: typeof isSettingsFileBroken
  settingsFilePath: typeof settingsFilePath
}

export const diskWorkspaceStore: WorkspaceStore = {
  loadSettings: () => loadSettings(),
  saveActiveWorkspace: (settings, id) =>
    saveGlobalSettings({ ...globalSettingsFor(settings), activeWorkspaceId: id }),
  listWorkspaces,
  createWorkspace,
  renameWorkspace,
  workspaceDir,
  workspaceTaskCount,
  readWorkspaceTasks,
  readAgentStatuses: (settings) => readAllAgentStatuses(settings),
  isSettingsFileBroken,
  settingsFilePath
}

export interface WorkspacesServicePorts extends Pick<HostPorts, 'broadcast' | 'trashItem'> {
  store: WorkspaceStore
  /** The active board, from the index. */
  activeTasks(): Task[]
  /** The workspace of every live terminal session. */
  liveSessions(): { workspaceId?: string }[]
  /** The last agent rollup the agents side pushed. */
  activity(): WorkspacesActivity
  // What a switch repoints, in the order `core/workspaceSession.ts` holds.
  resetSources(): void
  restartSourcePolling(): void
  closeIndex(): void
  startTaskWatcher(): void
  startAgentWatcher(): void
  notifyTasks(): void
  notifyAgents(): void
}

/**
 * Workspaces: listing, creating, renaming, deleting and switching them, plus the switcher's
 * summaries. A switch runs to completion synchronously, so two quick switches apply in order.
 */
export function createWorkspacesService(ports: WorkspacesServicePorts) {
  const { store } = ports

  const session = createWorkspaceSession({
    loadSettings: store.loadSettings,
    listWorkspaces: store.listWorkspaces,
    workspaceDir: store.workspaceDir,
    saveActiveWorkspace: store.saveActiveWorkspace,
    resetSources: ports.resetSources,
    restartSourcePolling: ports.restartSourcePolling,
    closeIndex: ports.closeIndex,
    startTaskWatcher: ports.startTaskWatcher,
    startAgentWatcher: ports.startAgentWatcher,
    notifyTasks: ports.notifyTasks,
    notifyAgents: ports.notifyAgents,
    broadcast: ports.broadcast,
    hasLiveSessions: (id) => ports.liveSessions().some((live) => live.workspaceId === id),
    trash: ports.trashItem
  })

  function overview(): WorkspaceOverview {
    const settings = store.loadSettings()
    const sessions = ports.liveSessions()
    return {
      activeId: settings.activeWorkspaceId,
      workspaces: store.listWorkspaces(settings).map((workspace) => ({
        ...workspace,
        taskCount: store.workspaceTaskCount(settings, workspace.id),
        liveSessions: sessions.filter((live) => live.workspaceId === workspace.id).length
      }))
    }
  }

  /**
   * Inbox group sizes per workspace, for the switcher's menu. Built on demand — it parses every
   * background workspace's task files, which is fine on a click but not on every hook event. The
   * active board comes from the index; the others are read from disk without writing. A workspace
   * that cannot be read is left out, so the menu shows its agent state alone.
   */
  function boardSummaries(): Record<string, WorkspaceBoardSummary> {
    const settings = store.loadSettings()
    const summaries: Record<string, WorkspaceBoardSummary> = {}
    for (const workspace of store.listWorkspaces(settings)) {
      try {
        const active = workspace.id === settings.activeWorkspaceId
        const scoped = active ? settings : pathsInWorkspace(settings, workspace.id)
        const tasks = active
          ? ports.activeTasks()
          : store.readWorkspaceTasks(settings, workspace.id)
        const agents = new Map(store.readAgentStatuses(scoped).map((s) => [s.taskId, s]))
        summaries[workspace.id] = summariseInbox(buildInbox(tasks, agents))
      } catch (error) {
        console.error(`Could not summarise workspace ${workspace.id}:`, error)
      }
    }
    return summaries
  }

  /** Workspaces whose `settings.json` does not parse, so Settings can say which file to fix. */
  function brokenSettingsFiles(): BrokenSettingsFile[] {
    const settings = store.loadSettings()
    return store
      .listWorkspaces(settings)
      .filter((workspace) => store.isSettingsFileBroken(settings, workspace.id))
      .map((workspace) => ({
        workspaceId: workspace.id,
        path: store.settingsFilePath(settings, workspace.id)
      }))
  }

  return {
    switchWorkspace: session.switchWorkspace,
    afterSettingsSave: session.afterSettingsSave,
    overview,
    activity: ports.activity,
    boardSummaries,
    brokenSettingsFiles,

    switch(id: string): WorkspaceOverview {
      session.switchWorkspace(id)
      return overview()
    },

    create(name: string): WorkspaceOverview {
      const settings = store.loadSettings()
      // A new board starts with Auto-run off whatever the one it was copied from does.
      const created = store.createWorkspace(settings, String(name), {
        ...workspaceSettingsFor(settings),
        autoDispatch: false,
        autoDispatchSince: undefined
      })
      session.switchWorkspace(created.id)
      return overview()
    },

    rename(id: string, name: string): WorkspaceOverview {
      store.renameWorkspace(store.loadSettings(), id, String(name))
      ports.notifyAgents()
      ports.broadcast('workspaces:changed')
      return overview()
    },

    async delete(id: string): Promise<WorkspaceOverview> {
      await session.deleteWorkspace(id)
      return overview()
    }
  }
}

export type WorkspacesService = ReturnType<typeof createWorkspacesService>
