import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { loadSettings, saveSettings, tasksDir } from '@core/config.js'
import { readAllAgentStatuses, recordAgentEvent } from '@core/agentStore.js'
import { isAgentArchived } from '@core/agentState.js'
import type { AgentStatus } from '@core/agentState.js'
import {
  planLaunch,
  renderPrompt,
  sessionTranscriptTime,
  workingDirFor,
  type LaunchOptions
} from '@core/launch.js'
import { providerFor } from '@core/providers/index.js'
import { resolveTemplateFor } from '@core/prompt.js'
import { readGitBranch, removeWorktree } from '@core/worktree.js'
import { planOrchestration, type OrchestrationPlan } from '@core/orchestrate.js'
import type { OrchestrationSummary } from '@core/types.js'
import {
  addNote,
  brokenTaskFiles,
  createTask,
  deleteTask,
  reorderTasks,
  updateTask
} from '@core/taskStore.js'
import {
  taskDraftSchema,
  taskFilterSchema,
  taskPatchSchema,
  settingsSchema
} from '@core/taskSchema.js'
import {
  TASK_STATUSES,
  type TaskPatch,
  type TaskStatus,
  type TerminalSessionInfo
} from '@core/types.js'
import { findTask, queryTasks, syncIndex } from './taskIndex.js'
import { CodexAppServer } from './codexAppServer.js'
import { updateTray } from './tray.js'
import {
  createSession,
  findSessionByTask,
  killSession,
  listSessions,
  resizeSession,
  sessionBacklog,
  writeToSession,
  type SpawnOptions
} from './terminal/ptyManager.js'

function broadcast(channel: string, payload?: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload)
}

/**
 * Agent records from disk, each tagged with the branch its working directory is on so the UI can
 * show where the work is actually landing.
 */
export function agentStatuses(): AgentStatus[] {
  const settings = loadSettings()
  const tasks = new Map(queryTasks().map((task) => [task.id, task]))
  return readAllAgentStatuses(settings).map((status) => {
    const task = tasks.get(status.taskId)
    const dir = task ? (task.worktreePath ?? workingDirFor(settings, task)) : undefined
    const branch = dir ? readGitBranch(dir) : undefined
    return branch ? { ...status, branch } : status
  })
}

export function markAgentExited(taskId: string): void {
  recordAgentEvent(loadSettings(), taskId, 'TerminalExit')
  notifyAgentsChanged()
}

export function notifyAgentsChanged(): void {
  const statuses = agentStatuses()
  broadcast('agents:changed', statuses)

  const tasks = new Map(queryTasks().map((task) => [task.id, task]))
  const listed = statuses.filter((status) => {
    const task = tasks.get(status.taskId)
    return task ? !isAgentArchived(task.status) : false
  })
  updateTray(listed, new Map([...tasks].map(([id, task]) => [id, task.title])))
}

export function notifyTasksChanged(): void {
  syncIndex()
  broadcast('tasks:changed')
}

/**
 * Starts (or focuses) an agent session for a task. Shared by the per-task launch and the
 * orchestrator so both advance the board and record the session the same way.
 */
const codexTasks = new Map<string, string>()
let appServer: CodexAppServer | undefined

function getCodexAppServer(command: string): CodexAppServer {
  if (!appServer) {
    appServer = new CodexAppServer(command, (threadId, event) => {
      const taskId = codexTasks.get(threadId)
      if (!taskId) return
      recordAgentEvent(loadSettings(), taskId, event)
      notifyAgentsChanged()
    })
  }
  return appServer
}

async function launchSessionForTask(
  taskId: string,
  options: LaunchOptions = {}
): Promise<TerminalSessionInfo> {
  const task = findTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  const live = findSessionByTask(taskId)
  if (live) return live

  const settings = loadSettings()
  let plan = planLaunch(settings, task, options)
  if (plan.provider === 'codex' && !plan.resumed) {
    const sessionId = await getCodexAppServer(settings.codexCommand).startThread(plan.cwd)
    codexTasks.set(sessionId, task.id)
    plan = planLaunch(settings, task, { ...options, sessionId })
  }

  const patch: TaskPatch = {}
  if (task.status === 'backlog') patch.status = 'in_progress'
  const provider = plan.provider
  if (task.claudeSessionId !== plan.sessionId && provider === 'claude')
    patch.claudeSessionId = plan.sessionId
  if (task.agentSession?.id !== plan.sessionId || task.agentSession.provider !== provider) {
    patch.agentSession = { provider, id: plan.sessionId }
  }
  const history = [...task.sessions]
  if (task.claudeSessionId && !history.some((entry) => entry.id === task.claudeSessionId)) {
    history.unshift({
      id: task.claudeSessionId,
      provider: 'claude',
      startedAt: sessionTranscriptTime(settings, task, task.claudeSessionId) ?? task.updatedAt,
      label: 'Earlier chat'
    })
  }
  if (!history.some((entry) => entry.id === plan.sessionId)) {
    history.push({
      id: plan.sessionId,
      provider,
      startedAt: new Date().toISOString(),
      label: resolveTemplateFor(settings, task, options.templateId).name
    })
  }
  if (history.length !== task.sessions.length) patch.sessions = history
  if (plan.worktreePath && task.worktreePath !== plan.worktreePath) {
    patch.worktreePath = plan.worktreePath
  }
  if (Object.keys(patch).length > 0) updateTask(task.id, patch)
  if (plan.warning) addNote(task.id, 'styr', plan.warning)
  if (Object.keys(patch).length > 0 || plan.warning) notifyTasksChanged()

  return createSession({
    cwd: plan.cwd,
    shell: settings.shell,
    title: task.title,
    taskId: task.id,
    command: plan.command,
    env: { STYR_TASK_ID: task.id, STYR_SESSION_ID: plan.sessionId }
  })
}

function buildPlan(): OrchestrationPlan {
  const liveTaskIds = new Set(
    listSessions()
      .map((session) => session.taskId)
      .filter(Boolean) as string[]
  )
  const agents = new Map(agentStatuses().map((status) => [status.taskId, status.state]))
  return planOrchestration(loadSettings(), queryTasks(), { liveTaskIds, agents })
}

/** The plan without the task objects, which the renderer does not need. */
function summarisePlan(): OrchestrationSummary {
  const plan = buildPlan()
  return {
    dispatch: plan.dispatch.map(({ task, lane }) => ({ taskId: task.id, title: task.title, lane })),
    occupied: plan.occupied,
    capacity: plan.capacity,
    eligible: plan.eligible,
    optedOut: plan.optedOut,
    missingWorkingDir: plan.missingWorkingDir,
    idleSessions: plan.idleSessions
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle('tasks:list', (_event, filter: unknown) =>
    queryTasks(taskFilterSchema.parse(filter ?? {}))
  )
  ipcMain.handle('tasks:get', (_event, id: string) => findTask(id))
  ipcMain.handle('tasks:problems', () => brokenTaskFiles())

  ipcMain.handle('tasks:removeWorktree', (_event, taskId: string) => {
    const task = findTask(taskId)
    if (!task?.repoPath) return null
    removeWorktree(task.repoPath, task.id)
    const updated = updateTask(task.id, { worktreePath: undefined })
    notifyTasksChanged()
    return updated
  })
  ipcMain.handle('agents:list', () => agentStatuses())

  ipcMain.handle('tasks:create', (_event, draft: unknown) => {
    const task = createTask(taskDraftSchema.parse(draft))
    notifyTasksChanged()
    return task
  })

  ipcMain.handle('tasks:update', (_event, id: string, patch: unknown) => {
    const task = updateTask(id, taskPatchSchema.parse(patch))
    notifyTasksChanged()
    return task
  })

  ipcMain.handle('tasks:note', (_event, id: string, author: string, message: string) => {
    const task = addNote(id, author, message)
    notifyTasksChanged()
    return task
  })

  ipcMain.handle('tasks:reorder', (_event, status: TaskStatus, orderedIds: string[]) => {
    if (!TASK_STATUSES.includes(status)) throw new Error(`Unknown status ${status}`)
    const tasks = reorderTasks(status, orderedIds)
    notifyTasksChanged()
    return tasks
  })

  ipcMain.handle('tasks:delete', (_event, id: string) => {
    deleteTask(id)
    notifyTasksChanged()
  })

  ipcMain.handle('tasks:reveal', (_event, id: string) => {
    const task = findTask(id)
    if (task) shell.showItemInFolder(task.filePath)
  })

  ipcMain.handle('tasks:openInEditor', (_event, id: string) => {
    const task = findTask(id)
    if (task) void shell.openPath(task.filePath)
  })

  ipcMain.handle('app:info', () => ({ isPackaged: app.isPackaged, version: app.getVersion() }))

  ipcMain.handle('app:mcpCommand', () => {
    const root = app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked')
      : app.getAppPath()
    const entry = join(root, 'out', 'main', 'mcp', 'index.mjs')
    return providerFor(loadSettings()).mcpInstallCommand(entry)
  })

  ipcMain.handle('orchestrate:plan', () => summarisePlan())

  ipcMain.handle('orchestrate:run', async (_event, taskIds?: string[]) => {
    const wanted = taskIds ? new Set(taskIds) : null
    const plan = buildPlan()
    return Promise.all(
      plan.dispatch
        .filter(({ task }) => !wanted || wanted.has(task.id))
        .map(async ({ task, lane }) => ({
          lane,
          taskId: task.id,
          session: launchSessionForTask(task.id, { withPrompt: true, fresh: lane === 'review' })
        }))
    )
  })

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:save', (_event, settings: unknown) => {
    const saved = saveSettings(settingsSchema.parse(settings))
    tasksDir(saved)
    notifyTasksChanged()
    broadcast('settings:changed', saved)
    return saved
  })

  ipcMain.handle('settings:pickDirectory', async (event, current?: string) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('settings:pickFiles', async (event, startIn?: string) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      defaultPath: startIn || loadSettings().defaultRepoPath || undefined
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('terminal:create', (_event, options: SpawnOptions) =>
    createSession({ ...options, shell: options.shell || loadSettings().shell })
  )

  /**
   * Starting a session on a Backlog task moves it to In Progress. Only Backlog is unambiguous —
   * launching on In Review is a review, and on Done a follow-up, neither of which is new work.
   */
  ipcMain.handle(
    'terminal:launchAgent',
    async (_event, taskId: string, templateId?: string, provider?: 'claude' | 'codex') =>
      launchSessionForTask(taskId, { templateId, provider })
  )

  ipcMain.handle('terminal:resumeSession', (_event, taskId: string, sessionId: string) => {
    const task = findTask(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    const settings = loadSettings()
    const plan = planLaunch(settings, task, { resume: sessionId })
    return createSession({
      cwd: plan.cwd,
      shell: settings.shell,
      title: task.title,
      taskId: task.id,
      replay: true,
      command: plan.command,
      env: { STYR_TASK_ID: task.id, STYR_SESSION_ID: plan.sessionId }
    })
  })

  ipcMain.handle('tasks:forgetSession', (_event, taskId: string) => {
    const task = updateTask(taskId, { claudeSessionId: undefined, agentSession: undefined })
    notifyTasksChanged()
    return task
  })

  ipcMain.handle('terminal:previewPrompt', (_event, taskId: string, templateId?: string) => {
    const task = findTask(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    return renderPrompt(loadSettings(), task, templateId)
  })

  ipcMain.on('terminal:write', (_event, id: string, data: string) => writeToSession(id, data))
  ipcMain.on('terminal:resize', (_event, id: string, cols: number, rows: number) =>
    resizeSession(id, cols, rows)
  )
  ipcMain.handle('terminal:kill', (_event, id: string) => killSession(id))
  ipcMain.handle('terminal:list', () => listSessions())
  ipcMain.handle('terminal:backlog', (_event, id: string) => sessionBacklog(id))
}

export { broadcast }
