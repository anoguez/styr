import { isAgentArchived, agentKey, type AgentStatus } from './agentState.js'
import { DEFAULT_WORKSPACE_ID, type Settings, type Task, type WorkspaceInfo } from './types.js'

/**
 * What switching, deleting and saving settings need from the outside world. The ordering between
 * these calls is the contract this module exists to hold — close the index before the watchers
 * restart, run a switch to completion without awaiting — and the ports let a test watch it.
 */
export interface WorkspaceSessionPorts {
  loadSettings(): Settings
  listWorkspaces(settings: Settings): WorkspaceInfo[]
  workspaceDir(settings: Settings, id?: string): string
  /** Persists the active-workspace preference. */
  saveActiveWorkspace(settings: Settings, id: string): void
  resetSources(): void
  restartSourcePolling(): void
  closeIndex(): void
  startTaskWatcher(): void
  startAgentWatcher(): void
  notifyTasks(): void
  notifyAgents(): void
  broadcast(channel: string, payload?: unknown): void
  hasLiveSessions(workspaceId: string): boolean
  trash(path: string): Promise<void>
}

export interface WorkspaceSession {
  switchWorkspace(id: string): void
  deleteWorkspace(id: string): Promise<void>
  afterSettingsSave(folderBefore: string, savedWorkspaceId: string): void
}

export function createWorkspaceSession(ports: WorkspaceSessionPorts): WorkspaceSession {
  /**
   * The index and watchers are created once at start, so a switch closes them and begins again.
   * The index closes first: a watcher restarted onto the new folder must never reach the old one.
   */
  function repoint(): void {
    ports.resetSources()
    ports.restartSourcePolling()
    ports.closeIndex()
    ports.startTaskWatcher()
    ports.startAgentWatcher()
    ports.notifyTasks()
    ports.notifyAgents()
  }

  /** Runs to completion synchronously, so two quick switches apply in order. */
  function switchWorkspace(id: string): void {
    const settings = ports.loadSettings()
    if (!ports.listWorkspaces(settings).some((workspace) => workspace.id === id)) {
      throw new Error('That workspace no longer exists.')
    }
    if (settings.activeWorkspaceId === id) return
    ports.saveActiveWorkspace(settings, id)
    repoint()
    ports.broadcast('settings:changed', ports.loadSettings())
    ports.broadcast('workspaces:changed')
  }

  async function deleteWorkspace(id: string): Promise<void> {
    const settings = ports.loadSettings()
    if (id === DEFAULT_WORKSPACE_ID) throw new Error('The Default workspace cannot be deleted.')
    if (!ports.listWorkspaces(settings).some((workspace) => workspace.id === id)) {
      throw new Error('That workspace no longer exists.')
    }
    if (ports.hasLiveSessions(id)) {
      throw new Error('Close this workspace’s terminal tabs before deleting it.')
    }
    if (settings.activeWorkspaceId === id) switchWorkspace(DEFAULT_WORKSPACE_ID)
    await ports.trash(ports.workspaceDir(settings, id))
    ports.startAgentWatcher()
    ports.notifyAgents()
    ports.broadcast('workspaces:changed')
  }

  /**
   * Brings the index, watchers and renderer in line with whatever reached the disk — called from a
   * `finally`, so a save that failed partway is covered too and the app never reads from one
   * storage folder while writing another.
   */
  function afterSettingsSave(folderBefore: string, savedWorkspaceId: string): void {
    const saved = ports.loadSettings()
    if (ports.workspaceDir(saved) !== folderBefore) repoint()
    else if (savedWorkspaceId === saved.activeWorkspaceId) ports.notifyTasks()
    ports.restartSourcePolling()
    ports.broadcast('settings:changed', saved)
  }

  return { switchWorkspace, deleteWorkspace, afterSettingsSave }
}

export interface TrayModel {
  /** Active workspace's non-archived agents, then the background ones. */
  statuses: AgentStatus[]
  titles: Map<string, string>
}

/**
 * What the menu bar and notifications show. Active-workspace agents drop out once their task is
 * Done, archived or gone from the index; each is tagged with its workspace so a key never changes
 * when another workspace appears, but the workspace is *named* only when there is more than one — a
 * lone "Default" in every menu entry is noise.
 */
export function buildTrayModel(
  settings: Pick<Settings, 'activeWorkspaceId'>,
  workspaces: WorkspaceInfo[],
  statuses: AgentStatus[],
  tasks: Pick<Task, 'id' | 'title' | 'status' | 'archivedAt'>[],
  background: { statuses: AgentStatus[]; titles: Map<string, string> }
): TrayModel {
  const active = workspaces.find((workspace) => workspace.id === settings.activeWorkspaceId)
  const label = workspaces.length > 1 ? active?.name : undefined
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const listed = statuses
    .filter((status) => {
      const task = byId.get(status.taskId)
      return task ? !isAgentArchived(task) : false
    })
    .map((status) => ({
      ...status,
      workspaceId: settings.activeWorkspaceId,
      ...(label ? { workspaceName: label } : {})
    }))
  const titles = new Map(
    listed.map((status) => [agentKey(status), byId.get(status.taskId)?.title ?? status.taskId])
  )
  for (const [key, title] of background.titles) titles.set(key, title)
  return { statuses: [...listed, ...background.statuses], titles }
}
