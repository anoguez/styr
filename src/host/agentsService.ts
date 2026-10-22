import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathsInWorkspace, workspaceDir } from '@core/config.js'
import {
  clearAgentStatus,
  readAllAgentStatuses,
  recordAgentEvent,
  recordSubagentEvent
} from '@core/agentStore.js'
import type { AgentConversation } from '@core/agentConversation.js'
import type { AgentStatus } from '@core/agentState.js'
import { renderPrompt, workingDirFor } from '@core/launch.js'
import { isPlanRun } from '@core/planning.js'
import type { ThreadUpdate } from '@core/providers/codexProtocol.js'
import {
  createSessionLifecycle,
  monitorKey,
  splitMonitorKey,
  type SessionPorts
} from '@core/sessionLifecycle.js'
import { loadSettings } from '@core/settingsStore.js'
import type { Settings, Task, TerminalSessionInfo, WorkspacesActivity } from '@core/types.js'
import { buildTrayModel, workspaceActivity } from '@core/workspaceSession.js'
import { listWorkspaces, readBackgroundAgents } from '@core/workspaces.js'
import { baseBranchFor, readGitBranch, workingTreeSummary } from '@core/worktree.js'
import type { HostPorts } from './ports.js'
import type { SpawnOptions } from './terminals/terminalsService.js'

/** The agent records, workspaces and handoff folder on disk, from `core/`. A test fakes them. */
export interface AgentStore {
  loadSettings(): Settings
  /** The agent records of the workspace `settings` is scoped to. */
  readAgentStatuses(settings: Settings): AgentStatus[]
  recordAgentEvent: SessionPorts['recordAgentEvent']
  recordSubagentEvent: SessionPorts['recordSubagentEvent']
  clearAgentStatus(settings: Settings, taskId: string): void
  listWorkspaces: typeof listWorkspaces
  /** Every other workspace's agents, read from its files without writing. */
  readBackgroundAgents: typeof readBackgroundAgents
  writeHandoff: SessionPorts['writeHandoff']
}

export const diskAgentStore: AgentStore = {
  loadSettings: () => loadSettings(),
  readAgentStatuses: (settings) => readAllAgentStatuses(settings),
  recordAgentEvent: (workspaceId, taskId, event) =>
    recordAgentEvent(pathsInWorkspace(loadSettings(), workspaceId), taskId, event),
  recordSubagentEvent: (workspaceId, taskId, event, subagent) =>
    recordSubagentEvent(
      pathsInWorkspace(loadSettings(), workspaceId),
      taskId,
      event,
      subagent ? { agent_id: subagent.id, label: subagent.label } : null
    ),
  clearAgentStatus,
  listWorkspaces,
  readBackgroundAgents,
  writeHandoff: (fileName, content) => {
    const folder = join(workspaceDir(loadSettings()), 'handoffs')
    const path = join(folder, fileName)
    mkdirSync(folder, { recursive: true })
    writeFileSync(path, content, 'utf8')
    return path
  }
}

/** The git reads a launch and the agent rows make, from `core/worktree.ts`. */
export const diskGit: SessionPorts['git'] = {
  branch: readGitBranch,
  baseBranch: baseBranchFor,
  workingTree: workingTreeSummary
}

/** What the service uses of the Codex app-server client (`codexMonitor.ts`). */
export interface AgentMonitor extends Pick<
  SessionPorts['monitor'],
  'expect' | 'watch' | 'release'
> {
  submitPrompt(key: string, text: string): Promise<void>
  answerApproval(key: string, approvalId: string, allow: boolean): Promise<void>
}

export interface AgentsServicePorts extends Pick<HostPorts, 'broadcast'> {
  store: AgentStore
  git: SessionPorts['git']
  /** The active board, from the index, and the task-file operations a launch makes. */
  tasks: Pick<SessionPorts, 'findTask' | 'getTask' | 'updateTask' | 'addNote' | 'createTask'> & {
    query(): Task[]
    setArchived(taskId: string, archived: boolean): unknown
    /** The task-file half of `agents:remove` (`tasksService.removeAgent`). */
    removeAgent(taskId: string): void
  }
  notifyTasks(): void
  pinWorkspace: SessionPorts['pinWorkspace']
  /** The terminals service. */
  terminals: Pick<
    SessionPorts,
    'findSessionByTask' | 'listSessions' | 'killSession' | 'writeToSession' | 'runtimeState'
  > & { createSession(options: SpawnOptions): TerminalSessionInfo }
  /** Creates the Codex app-server client. Called once, when the service is created. */
  createMonitor(
    onUpdate: (update: ThreadUpdate) => void,
    onConversation: (key: string, conversation: AgentConversation) => void
  ): AgentMonitor
  /** Hands a Codex conversation to the terminal's agent view (`usage.ts`). */
  publishConversation(
    sessionId: string,
    conversation: AgentConversation,
    submitPrompt: (text: string) => Promise<void>,
    answerApproval: (approvalId: string, option: string) => Promise<void>
  ): void
  /** The agent's own prompt channel in a terminal (`usage.ts`), for Request changes. */
  prompts: Pick<SessionPorts, 'promptInbox' | 'promptAgent'>
  ensureAgentCli: SessionPorts['ensureAgentCli']
  prepareCodex: SessionPorts['prepareCodex']
  planLaunch: SessionPorts['planLaunch']
  /** The menu bar and its "needs you" notifications, given the tray model. */
  updateTray(statuses: AgentStatus[], titles: Map<string, string>): void
  /** Arms an Auto-run pass; the runner coalesces a burst of requests into one. */
  requestAutoRun(): void
}

/**
 * The agents: their records, the refresh that follows every change to one (sidebar, tray,
 * workspace switcher, Auto-run), the Codex monitor and the session lifecycle that launches them.
 * Like the tasks service, the refresh is synchronous.
 */
export function createAgentsService(ports: AgentsServicePorts) {
  const { store, tasks, terminals } = ports

  /**
   * Agent records from disk, each tagged with the branch its working directory is on so the UI can
   * show where the work is actually landing.
   */
  function agentStatuses(): AgentStatus[] {
    const settings = store.loadSettings()
    const byId = new Map(tasks.query().map((task) => [task.id, task]))
    return store.readAgentStatuses(settings).map((status) => {
      const task = byId.get(status.taskId)
      const dir = task ? (task.worktreePath ?? workingDirFor(settings, task)) : undefined
      const branch = dir ? ports.git.branch(dir) : undefined
      return branch ? { ...status, branch } : status
    })
  }

  /**
   * The last rollup `notifyAgentsChanged` pushed, so a window's first paint needs no hook event.
   * Startup runs it before the first window opens; the fallback only covers a call before that.
   */
  let latestActivity: WorkspacesActivity | undefined

  function activity(): WorkspacesActivity {
    return latestActivity ?? { activeId: store.loadSettings().activeWorkspaceId, byWorkspace: {} }
  }

  function notifyAgentsChanged(): void {
    const statuses = agentStatuses()
    ports.broadcast('agents:changed', statuses)

    const settings = store.loadSettings()
    const model = buildTrayModel(
      settings,
      store.listWorkspaces(settings),
      statuses,
      tasks.query(),
      store.readBackgroundAgents(settings, settings.activeWorkspaceId)
    )
    ports.updateTray(model.statuses, model.titles)
    latestActivity = {
      activeId: settings.activeWorkspaceId,
      byWorkspace: workspaceActivity(model)
    }
    ports.broadcast('workspaces:activity', latestActivity)
    ports.requestAutoRun()
  }

  /**
   * Turns the Codex daemon's lifecycle broadcasts into the same agent records a Claude hook writes,
   * so the sidebar, tray and terminal dots need no Codex-specific code. Created before the
   * lifecycle below; updates only arrive once both exist.
   */
  const monitor = ports.createMonitor(
    (update) => lifecycle.recordCodexUpdate(update),
    (key, conversation) => {
      const { workspaceId, taskId } = splitMonitorKey(key)
      const session = terminals.findSessionByTask(taskId, workspaceId)
      if (session)
        ports.publishConversation(
          session.id,
          conversation,
          (text) => monitor.submitPrompt(key, text),
          (approvalId, option) => monitor.answerApproval(key, approvalId, option === 'allow')
        )
    }
  )

  const lifecycle = createSessionLifecycle({
    settings: store.loadSettings,
    findTask: tasks.findTask,
    getTask: tasks.getTask,
    updateTask: tasks.updateTask,
    addNote: tasks.addNote,
    createTask: tasks.createTask,
    notifyTasks: ports.notifyTasks,
    notifyAgents: notifyAgentsChanged,
    recordAgentEvent: store.recordAgentEvent,
    recordSubagentEvent: store.recordSubagentEvent,
    pinWorkspace: ports.pinWorkspace,
    ...terminals,
    agentStatuses,
    ...ports.prompts,
    monitor,
    ensureAgentCli: ports.ensureAgentCli,
    prepareCodex: ports.prepareCodex,
    planLaunch: ports.planLaunch,
    git: ports.git,
    writeHandoff: store.writeHandoff
  })

  /** Agents the user removed while live: their terminal's exit must not write a status back. */
  const removedWhileLive = new Set<string>()

  function markAgentExited(
    taskId: string,
    workspaceId = store.loadSettings().activeWorkspaceId
  ): void {
    monitor.release(monitorKey(workspaceId, taskId))
    if (removedWhileLive.delete(monitorKey(workspaceId, taskId))) {
      notifyAgentsChanged()
      return
    }
    store.recordAgentEvent(workspaceId, taskId, 'TerminalExit')
    archivePlanRun(taskId, workspaceId)
    notifyAgentsChanged()
  }

  /** A ⌘↵ planning run leaves no card behind: its throwaway task is archived when the session ends. */
  function archivePlanRun(taskId: string, workspaceId: string): void {
    try {
      const archived = ports.pinWorkspace(workspaceId, () => {
        const task = tasks.getTask(taskId)
        if (!task || !isPlanRun(task) || task.archivedAt) return false
        tasks.setArchived(taskId, true)
        return true
      })
      if (archived) ports.notifyTasks()
    } catch (error) {
      console.error('Could not archive the planning run:', error)
    }
  }

  /**
   * Removes the agent from the board: ends its live terminal, drops its status and forgets the
   * current chat. The chat history on the task stays.
   */
  function remove(taskId: string): void {
    const settings = store.loadSettings()
    const workspaceId = settings.activeWorkspaceId
    const live = terminals.findSessionByTask(taskId, workspaceId)
    if (live) {
      removedWhileLive.add(monitorKey(workspaceId, taskId))
      terminals.killSession(live.id)
    }
    monitor.release(monitorKey(workspaceId, taskId))
    store.clearAgentStatus(settings, taskId)
    tasks.removeAgent(taskId)
  }

  /** Reopens one of the task's chats in a new terminal of the active workspace. */
  async function resume(taskId: string, sessionId: string): Promise<TerminalSessionInfo> {
    const task = tasks.findTask(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    const settings = store.loadSettings()
    const entry = task.sessions.find((item) => item.id === sessionId)
    const plan = ports.planLaunch(settings, task, { resume: sessionId, provider: entry?.provider })
    await ports.ensureAgentCli(plan.provider, settings)
    if (plan.provider === 'codex') await ports.prepareCodex(settings.codexCommand, settings.shell)
    return terminals.createSession({
      cwd: plan.cwd,
      shell: settings.shell,
      title: task.title,
      taskId: task.id,
      workspaceId: settings.activeWorkspaceId,
      provider: plan.provider,
      replay: true,
      command: plan.command,
      env: {
        STYR_TASK_ID: task.id,
        STYR_WORKSPACE_ID: settings.activeWorkspaceId,
        STYR_SESSION_ID: plan.sessionId
      }
    })
  }

  /** The prompt a launch with `templateId` would send, for the launch menu's preview. */
  function previewPrompt(taskId: string, templateId?: string): string {
    const task = ports.tasks.findTask(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    return renderPrompt(store.loadSettings(), task, templateId)
  }

  return {
    agentStatuses,
    notifyAgentsChanged,
    activity,
    markAgentExited,
    remove,
    resume,
    previewPrompt,
    launch: lifecycle.startForTask,
    askForPullRequest: lifecycle.askForPullRequest,
    askReview: lifecycle.askReview,
    askFork: lifecycle.askFork,
    handOff: lifecycle.handOff,
    reviewRoute: lifecycle.reviewRoute,
    deliverReview: lifecycle.deliverReview
  }
}

export type AgentsService = ReturnType<typeof createAgentsService>
