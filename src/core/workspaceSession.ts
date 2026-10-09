import {
  AGENT_STATES,
  AGENT_STATE_ORDER,
  isAgentArchived,
  agentKey,
  type AgentState,
  type AgentStatus
} from './agentState.js'
import { awaitsReview } from './inbox.js'
import {
  DEFAULT_WORKSPACE_ID,
  type Settings,
  type Task,
  type WorkspaceAgentActivity,
  type WorkspaceInfo
} from './types.js'

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
  /** `agentKey`s of agents whose task awaits your review (`awaitsReview`). */
  awaitingReview: Set<string>
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
  tasks: (Pick<Task, 'id' | 'title' | 'status' | 'archivedAt'> &
    Partial<Pick<Task, 'readiness'>>)[],
  background: {
    statuses: AgentStatus[]
    titles: Map<string, string>
    awaitingReview?: ReadonlySet<string>
  }
): TrayModel {
  const active = workspaces.find((workspace) => workspace.id === settings.activeWorkspaceId)
  const label = workspaces.length > 1 ? active?.name : undefined
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const listed: AgentStatus[] = []
  const titles = new Map<string, string>()
  const awaitingReview = new Set(background.awaitingReview)
  for (const status of statuses) {
    const task = byId.get(status.taskId)
    if (!task || isAgentArchived(task)) continue
    const tagged = {
      ...status,
      workspaceId: settings.activeWorkspaceId,
      ...(label ? { workspaceName: label } : {})
    }
    listed.push(tagged)
    titles.set(agentKey(tagged), task.title)
    if (awaitsReview(task, status.state)) awaitingReview.add(agentKey(tagged))
  }
  for (const [key, title] of background.titles) titles.set(key, title)
  return { statuses: [...listed, ...background.statuses], titles, awaitingReview }
}

function emptyCounts(): Record<AgentState, number> {
  return Object.fromEntries(AGENT_STATES.map((state) => [state, 0])) as Record<AgentState, number>
}

/**
 * Rolls the tray's agent list up per workspace for the workspace switcher. It takes the tray model
 * rather than reading anything, so it adds no disk reads to the hook path and the switcher and the
 * menu bar can never disagree. A status without a workspace is skipped: the tray tags every row it
 * keeps.
 */
export function workspaceActivity(
  model: Pick<TrayModel, 'statuses' | 'awaitingReview'>
): Record<string, WorkspaceAgentActivity> {
  const activity: Record<string, WorkspaceAgentActivity> = {}
  for (const status of model.statuses) {
    if (!status.workspaceId) continue
    const entry = (activity[status.workspaceId] ??= { counts: emptyCounts(), review: 0 })
    entry.counts[status.state] += 1
    if (model.awaitingReview.has(agentKey(status))) entry.review += 1
    if (status.state === 'exited') continue
    if (!entry.top || AGENT_STATE_ORDER[status.state] < AGENT_STATE_ORDER[entry.top]) {
      entry.top = status.state
    }
  }
  return activity
}
