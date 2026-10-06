import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { opensTextFiles, type AppInfo } from '@core/appFilter.js'
import { pathsInWorkspace, pinWorkspace, workspaceDir } from '@core/config.js'
import {
  isSettingsFileBroken,
  loadSettings,
  persistSettings,
  saveGlobalSettings,
  settingsFilePath
} from '@core/settingsStore.js'
import { readAllAgentStatuses, recordAgentEvent } from '@core/agentStore.js'
import { agentKey, isAgentArchived } from '@core/agentState.js'
import type { AgentStatus } from '@core/agentState.js'
import {
  planLaunch,
  renderPrompt,
  workingDirFor,
  type LaunchOptions,
  type LaunchPlan
} from '@core/launch.js'
import { providerFor } from '@core/providers/index.js'
import { resolveTemplateFor } from '@core/prompt.js'
import { z } from 'zod'
import type { DiffResult, DiffStat, PatchResult } from '@core/diff.js'
import {
  findGitRoot,
  baseBranchFor,
  listBranches,
  readGitBranch,
  removeWorktree,
  taskDiff,
  taskFilePatch,
  workingTreeSummary
} from '@core/worktree.js'
import { createPullRequestPrompt } from '@core/pullRequest.js'
import {
  agentHandoffPrompt,
  handoffFileName,
  isAgentProgram,
  renderHandoff
} from '@core/handoff.js'
import {
  createWorkspace,
  listWorkspaces,
  readBackgroundAgents,
  renameWorkspace,
  workspaceTaskCount
} from '@core/workspaces.js'
import { planOrchestration, providerForLane, type OrchestrationPlan } from '@core/orchestrate.js'
import {
  DEFAULT_WORKSPACE_ID,
  globalSettingsFor,
  workspaceSettingsFor,
  worktreeKey,
  WORKTREE_BRANCH_PREFIX,
  type BrokenSettingsFile,
  type OrchestrationSummary,
  type WorkspaceOverview
} from '@core/types.js'
import {
  addNote,
  brokenTaskFiles,
  createTask,
  deleteTask,
  getTask,
  reorderTasks,
  setArchived,
  updateTask
} from '@core/taskStore.js'
import { settleLandedTasks } from './landing.js'
import {
  taskDraftSchema,
  taskFilterSchema,
  taskPatchSchema,
  settingsChangeSchema,
  workspaceIdSchema
} from '@core/taskSchema.js'
import {
  TASK_STATUSES,
  type Task,
  type TaskPatch,
  type TaskStatus,
  type TerminalSessionInfo
} from '@core/types.js'
import { closeIndex, findTask, queryTasks, syncIndex } from './taskIndex.js'
import { startWatching, startWatchingAgents } from './watcher.js'
import { updateTray } from './tray.js'
import {
  createSession,
  findSessionByTask,
  killSession,
  listSessions,
  resizeSession,
  sessionBacklog,
  terminalRuntimeState,
  writeToSession,
  type SpawnOptions
} from './terminal/ptyManager.js'
import { TaskLaunchGate } from './terminal/taskLaunchGate.js'
import { CodexMonitor, prepareCodex } from './codexMonitor.js'

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

/**
 * Turns the Codex daemon's lifecycle broadcasts into the same agent records a Claude hook writes,
 * so the sidebar, tray and terminal dots need no Codex-specific code.
 */
/** The template a fresh Codex launch used, for labelling its history entry once the id arrives. */
const pendingTemplates = new Map<string, string | undefined>()

/**
 * The monitor is keyed by one string, and task ids repeat across workspaces — so it is handed
 * `<workspace>:<task>` and the pair is recovered from its updates. Workspace ids never contain a
 * colon, so the first one splits it.
 */
function monitorKey(workspaceId: string, taskId: string): string {
  return `${workspaceId}:${taskId}`
}

function splitMonitorKey(key: string): { workspaceId: string; taskId: string } {
  const at = key.indexOf(':')
  return { workspaceId: key.slice(0, at), taskId: key.slice(at + 1) }
}

/**
 * Runs `work` with every task path resolved inside another workspace. Synchronous on purpose:
 * nothing else can observe the override while it is set.
 */
function inOtherWorkspace<T>(workspaceId: string, work: () => T): T {
  pinWorkspace(workspaceId)
  try {
    return work()
  } finally {
    pinWorkspace(undefined)
  }
}

const codexMonitor = new CodexMonitor((update) => {
  const { workspaceId, taskId } = splitMonitorKey(update.taskId)
  const settings = loadSettings()
  recordAgentEvent(pathsInWorkspace(settings, workspaceId), taskId, update.event)
  if (update.boundSessionId) {
    const key = monitorKey(workspaceId, taskId)
    if (workspaceId === settings.activeWorkspaceId) {
      const task = findTask(taskId)
      if (task) {
        saveLaunchMetadata(
          task,
          { provider: 'codex' },
          pendingTemplates.get(key),
          update.boundSessionId
        )
      }
    } else {
      // The board shows another workspace now; write the thread id into the file it belongs to.
      // The index catches up when that workspace is next opened.
      inOtherWorkspace(workspaceId, () => {
        const task = getTask(taskId)
        if (!task) return
        const patch = launchPatch(
          task,
          { provider: 'codex' },
          pendingTemplates.get(key),
          update.boundSessionId
        )
        if (Object.keys(patch).length > 0) updateTask(taskId, patch)
      })
    }
    pendingTemplates.delete(key)
  }
  notifyAgentsChanged()
})

export function markAgentExited(
  taskId: string,
  workspaceId = loadSettings().activeWorkspaceId
): void {
  codexMonitor.release(monitorKey(workspaceId, taskId))
  recordAgentEvent(pathsInWorkspace(loadSettings(), workspaceId), taskId, 'TerminalExit')
  notifyAgentsChanged()
}

export /** Resolves the task a diff request names; errors come back as data, not as a thrown IPC failure. */
function diffTask(taskId: unknown): (Task & { repoPath: string }) | { error: string } {
  const id = z.string().min(1).safeParse(taskId)
  if (!id.success) return { error: 'Invalid task id' }
  const task = findTask(id.data)
  if (!task) return { error: 'Task not found' }
  if (!task.repoPath) return { error: 'This task has no repository' }
  return { ...task, repoPath: task.repoPath }
}

export function notifyAgentsChanged(): void {
  const statuses = agentStatuses()
  broadcast('agents:changed', statuses)

  const settings = loadSettings()
  const workspaces = listWorkspaces(settings)
  const active = workspaces.find((workspace) => workspace.id === settings.activeWorkspaceId)
  // Always tagged, so a key never changes when another workspace appears; named only when there
  // is more than one, because a lone "Default" in every menu entry is noise.
  const label = workspaces.length > 1 ? active?.name : undefined
  const tasks = new Map(queryTasks().map((task) => [task.id, task]))
  const background = readBackgroundAgents(settings, settings.activeWorkspaceId)
  const listed = statuses
    .filter((status) => {
      const task = tasks.get(status.taskId)
      return task ? !isAgentArchived(task) : false
    })
    .map((status) => ({
      ...status,
      workspaceId: settings.activeWorkspaceId,
      ...(label ? { workspaceName: label } : {})
    }))
  const titles = new Map(
    listed.map((status) => [agentKey(status), tasks.get(status.taskId)?.title ?? status.taskId])
  )
  for (const [key, title] of background.titles) titles.set(key, title)
  updateTray([...listed, ...background.statuses], titles)
}

export function notifyTasksChanged(): void {
  syncIndex()
  if (settleLandedTasks()) syncIndex()
  broadcast('tasks:changed')
}

/**
 * Starts (or focuses) an agent session for a task. Shared by the per-task launch and the
 * orchestrator so both advance the board and record the session the same way.
 */
const taskLaunches = new TaskLaunchGate()

function launchPatch(
  task: Task,
  plan: Pick<LaunchPlan, 'provider' | 'worktreePath'>,
  templateId: string | undefined,
  sessionId?: string
): TaskPatch {
  const patch: TaskPatch = {}
  if (task.status === 'backlog') patch.status = 'in_progress'
  if (plan.worktreePath && task.worktreePath !== plan.worktreePath) {
    patch.worktreePath = plan.worktreePath
  }
  if (!sessionId) return patch

  if (task.agentSession?.id !== sessionId || task.agentSession?.provider !== plan.provider) {
    patch.agentSession = { provider: plan.provider, id: sessionId }
  }
  if (!task.sessions.some((entry) => entry.id === sessionId)) {
    patch.sessions = [
      ...task.sessions,
      {
        id: sessionId,
        provider: plan.provider,
        startedAt: new Date().toISOString(),
        label: resolveTemplateFor(loadSettings(), task, templateId).name
      }
    ]
  }
  return patch
}

function saveLaunchMetadata(
  task: Task,
  plan: Pick<LaunchPlan, 'provider' | 'worktreePath' | 'warning'>,
  templateId: string | undefined,
  sessionId?: string
): void {
  const patch = launchPatch(task, plan, templateId, sessionId)
  if (Object.keys(patch).length > 0) updateTask(task.id, patch)
  if (plan.warning) addNote(task.id, 'styr', plan.warning)
  if (Object.keys(patch).length > 0 || plan.warning) notifyTasksChanged()
}

async function launchSessionForTask(
  taskId: string,
  options: LaunchOptions = {}
): Promise<TerminalSessionInfo> {
  // Task ids repeat across workspaces, so "one live session per task" is per workspace too.
  const workspaceId = loadSettings().activeWorkspaceId
  return taskLaunches.startOrReuse(
    monitorKey(workspaceId, taskId),
    () => findSessionByTask(taskId, workspaceId),
    () => startSessionForTask(taskId, options)
  )
}

async function startSessionForTask(
  taskId: string,
  options: LaunchOptions = {}
): Promise<TerminalSessionInfo> {
  const task = findTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  const settings = loadSettings()
  const workspaceId = settings.activeWorkspaceId
  const key = monitorKey(workspaceId, task.id)
  const requestedProvider =
    options.provider ?? task.agentSession?.provider ?? task.provider ?? settings.defaultProvider
  if (!settings.enabledProviders.includes(requestedProvider)) {
    throw new Error(
      `${requestedProvider === 'codex' ? 'Codex' : 'Claude Code'} is disabled in Settings → Integrations.`
    )
  }
  // Codex is refused up front when it cannot be monitored: a session with no live status is worse
  // than an error that says what to fix. Nothing has been written yet, so a refusal leaves no trace.
  const socketPath =
    requestedProvider === 'codex' ? await prepareCodex(settings.codexCommand) : undefined
  // The board may have switched while Codex was being checked; everything below writes to the
  // active workspace's files, so it must still be the one this launch was planned in.
  if (loadSettings().activeWorkspaceId !== workspaceId) {
    throw new Error('The workspace changed while the agent was starting. Try again.')
  }

  const plan = planLaunch(settings, task, options)
  // A fresh Codex thread is created by the TUI, so its id is only known once the daemon announces
  // it; the monitor saves it then. Every other session has its id up front.
  const awaitingThreadId = plan.provider === 'codex' && !plan.resumed
  saveLaunchMetadata(task, plan, options.templateId, awaitingThreadId ? undefined : plan.sessionId)

  if (socketPath) {
    if (awaitingThreadId) {
      pendingTemplates.set(key, options.templateId)
      await codexMonitor.expect(socketPath, key, plan.cwd)
    } else await codexMonitor.watch(socketPath, key, plan.sessionId)
  }
  try {
    const session = createSession({
      cwd: plan.cwd,
      shell: settings.shell,
      title: task.title,
      taskId: task.id,
      workspaceId,
      provider: plan.provider,
      command: plan.command,
      env: {
        STYR_TASK_ID: task.id,
        STYR_WORKSPACE_ID: workspaceId,
        ...(awaitingThreadId ? {} : { STYR_SESSION_ID: plan.sessionId })
      }
    })
    if (plan.provider === 'codex' && plan.resumed) {
      recordAgentEvent(settings, task.id, 'SessionStart')
      notifyAgentsChanged()
    }
    return session
  } catch (error) {
    codexMonitor.release(key)
    pendingTemplates.delete(key)
    throw error
  }
}

function buildPlan(): OrchestrationPlan {
  const active = loadSettings().activeWorkspaceId
  const liveTaskIds = new Set(
    listSessions()
      .filter((session) => session.workspaceId === active)
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
    dispatch: plan.dispatch.map(({ task, lane }) => ({
      taskId: task.id,
      title: task.title,
      lane,
      provider: providerForLane(loadSettings(), lane)
    })),
    occupied: plan.occupied,
    capacity: plan.capacity,
    eligible: plan.eligible,
    optedOut: plan.optedOut,
    missingWorkingDir: plan.missingWorkingDir,
    idleSessions: plan.idleSessions
  }
}

/**
 * Opens the index and watchers on the active workspace's folders. They are created once at start,
 * so a switch has to close them and begin again — the watchers' own `close` clears its handle
 * before awaiting, which is what makes restarting them here safe.
 */
function repoint(): void {
  closeIndex()
  startWatching(() => notifyTasksChanged())
  startWatchingAgents(() => notifyAgentsChanged())
  notifyTasksChanged()
  notifyAgentsChanged()
}

/**
 * Brings the index, watchers and renderer in line with whatever reached the disk — after a save
 * that failed partway too, so the app never reads from one storage folder while writing another.
 */
function refreshAfterSettingsSave(folderBefore: string, savedWorkspaceId: string): void {
  const saved = loadSettings()
  if (workspaceDir(saved) !== folderBefore) repoint()
  else if (savedWorkspaceId === saved.activeWorkspaceId) notifyTasksChanged()
  broadcast('settings:changed', saved)
}

function brokenSettingsFiles(): BrokenSettingsFile[] {
  const settings = loadSettings()
  return listWorkspaces(settings)
    .filter((workspace) => isSettingsFileBroken(settings, workspace.id))
    .map((workspace) => ({
      workspaceId: workspace.id,
      path: settingsFilePath(settings, workspace.id)
    }))
}

function workspaceOverview(): WorkspaceOverview {
  const settings = loadSettings()
  const sessions = listSessions()
  return {
    activeId: settings.activeWorkspaceId,
    workspaces: listWorkspaces(settings).map((workspace) => ({
      ...workspace,
      taskCount: workspaceTaskCount(settings, workspace.id),
      liveSessions: sessions.filter((session) => session.workspaceId === workspace.id).length
    }))
  }
}

/**
 * Makes another workspace the one the board shows. Runs to completion synchronously, so two quick
 * switches are applied in order and a stale one cannot overwrite a newer.
 */
export function switchWorkspace(id: string): void {
  const settings = loadSettings()
  if (!listWorkspaces(settings).some((workspace) => workspace.id === id)) {
    throw new Error('That workspace no longer exists.')
  }
  if (settings.activeWorkspaceId === id) return
  saveGlobalSettings({ ...globalSettingsFor(settings), activeWorkspaceId: id })
  repoint()
  broadcast('settings:changed', loadSettings())
  broadcast('workspaces:changed')
}

/** Removes the folder to the Trash — recoverable — and refuses while an agent is running in it. */
async function deleteWorkspace(id: string): Promise<void> {
  const settings = loadSettings()
  if (id === DEFAULT_WORKSPACE_ID) throw new Error('The Default workspace cannot be deleted.')
  if (!listWorkspaces(settings).some((workspace) => workspace.id === id)) {
    throw new Error('That workspace no longer exists.')
  }
  if (listSessions().some((session) => session.workspaceId === id)) {
    throw new Error('Close this workspace’s terminal tabs before deleting it.')
  }
  if (settings.activeWorkspaceId === id) switchWorkspace(DEFAULT_WORKSPACE_ID)
  await shell.trashItem(workspaceDir(settings, id))
  startWatchingAgents(() => notifyAgentsChanged())
  notifyAgentsChanged()
  broadcast('workspaces:changed')
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
    removeWorktree(task.repoPath, worktreeKey(loadSettings().activeWorkspaceId, task.id))
    const updated = updateTask(task.id, { worktreePath: undefined })
    notifyTasksChanged()
    return updated
  })
  ipcMain.handle('git:branches', (_event, repoPath: string) => listBranches(repoPath))
  ipcMain.handle('git:taskDiff', (_event, taskId: unknown): DiffResult => {
    const task = diffTask(taskId)
    if ('error' in task) return task
    return taskDiff(task.repoPath, worktreeKey(loadSettings().activeWorkspaceId, task.id), {
      worktree: task.useWorktree !== false,
      baseBranch: task.baseBranch
    })
  })
  ipcMain.handle(
    'git:filePatch',
    (_event, taskId: unknown, path: unknown, full?: unknown): PatchResult => {
      const task = diffTask(taskId)
      if ('error' in task) return task
      const file = z.string().min(1).safeParse(path)
      if (!file.success) return { error: 'Invalid path' }
      return taskFilePatch(
        task.repoPath,
        worktreeKey(loadSettings().activeWorkspaceId, task.id),
        { worktree: task.useWorktree !== false, baseBranch: task.baseBranch },
        file.data,
        full === true
      )
    }
  )
  ipcMain.handle('git:diffStats', (): Record<string, DiffStat> => {
    const workspaceId = loadSettings().activeWorkspaceId
    const stats: Record<string, DiffStat> = {}
    for (const task of queryTasks()) {
      // Done work has landed (or is being cleaned up); a count there is noise.
      if (!task.worktreePath || !task.repoPath || task.status === 'done' || task.archivedAt)
        continue
      const diff = taskDiff(task.repoPath, worktreeKey(workspaceId, task.id), {
        worktree: task.useWorktree !== false,
        baseBranch: task.baseBranch
      })
      if ('error' in diff || diff.kind !== 'changes') continue
      stats[task.id] = {
        added: diff.totalAdditions,
        removed: diff.totalDeletions,
        files: diff.totalFiles
      }
    }
    return stats
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

  ipcMain.handle('tasks:archive', (_event, id: string, archived: boolean) => {
    const task = setArchived(id, archived)
    notifyTasksChanged()
    notifyAgentsChanged()
    return task
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
    if (task) void openPathWith(task.filePath)
  })

  ipcMain.handle('app:info', () => ({ isPackaged: app.isPackaged, version: app.getVersion() }))

  ipcMain.handle('app:mcpCommand', (_event, provider?: 'claude' | 'codex') => {
    const root = app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked')
      : app.getAppPath()
    const entry = join(root, 'out', 'main', 'mcp', 'index.mjs')
    return providerFor({
      ...loadSettings(),
      defaultProvider: provider ?? 'claude'
    }).mcpInstallCommand(entry)
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
          session: launchSessionForTask(task.id, {
            withPrompt: true,
            fresh: lane === 'review',
            provider: providerForLane(loadSettings(), lane)
          })
        }))
    )
  })

  ipcMain.handle('settings:get', (_event, workspaceId: unknown) =>
    loadSettings(workspaceIdSchema.optional().parse(workspaceId))
  )
  ipcMain.handle('settings:save', (_event, change: unknown) => {
    const parsed = settingsChangeSchema.parse(change)
    const folderBefore = workspaceDir(loadSettings())
    try {
      persistSettings(parsed)
    } finally {
      refreshAfterSettingsSave(folderBefore, parsed.workspaceId)
    }
    return loadSettings()
  })
  ipcMain.handle('settings:brokenFiles', () => brokenSettingsFiles())

  ipcMain.handle('workspaces:list', () => workspaceOverview())
  ipcMain.handle('workspaces:switch', (_event, id: string) => {
    switchWorkspace(id)
    return workspaceOverview()
  })
  ipcMain.handle('workspaces:create', (_event, name: string) => {
    const settings = loadSettings()
    const created = createWorkspace(settings, String(name), workspaceSettingsFor(settings))
    switchWorkspace(created.id)
    return workspaceOverview()
  })
  ipcMain.handle('workspaces:rename', (_event, id: string, name: string) => {
    renameWorkspace(loadSettings(), id, String(name))
    notifyAgentsChanged()
    broadcast('workspaces:changed')
    return workspaceOverview()
  })
  ipcMain.handle('workspaces:delete', async (_event, id: string) => {
    await deleteWorkspace(id)
    return workspaceOverview()
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

  ipcMain.handle('settings:listApps', () => listInstalledApps())

  ipcMain.handle('settings:pickApp', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      properties: ['openFile'],
      defaultPath: '/Applications',
      filters: [{ name: 'Applications', extensions: ['app'] }]
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const picked = result.canceled ? undefined : result.filePaths[0]
    return picked ? basename(picked, '.app') : null
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

  ipcMain.handle('terminal:resumeSession', async (_event, taskId: string, sessionId: string) => {
    const task = findTask(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    const settings = loadSettings()
    const entry = task.sessions.find((item) => item.id === sessionId)
    const plan = planLaunch(settings, task, { resume: sessionId, provider: entry?.provider })
    if (plan.provider === 'codex') await prepareCodex(settings.codexCommand)
    return createSession({
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
  })

  ipcMain.handle('tasks:forgetSession', (_event, taskId: string) => {
    const task = updateTask(taskId, { agentSession: undefined })
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
  ipcMain.handle('terminal:runtimeState', (_event, id: string) => terminalRuntimeState(id))
  ipcMain.handle('terminal:createPr', (_event, taskId: string) => askForPullRequest(taskId))
  ipcMain.handle('terminal:askReview', (_event, taskId: string) => askReview(taskId))
  ipcMain.handle('terminal:handOff', (_event, sessionId: string, output: string) =>
    handOffSession(sessionId, String(output ?? ''))
  )
  ipcMain.handle('terminal:gitContext', (_event, path: string) => {
    const root = findGitRoot(path)
    return { root: root ?? null, branch: (root && readGitBranch(root)) ?? null }
  })
  ipcMain.handle('terminal:openInCode', async (_event, path: string) => {
    const opened = await new Promise<boolean>((resolve) =>
      execFile('open', ['-a', 'Visual Studio Code', path], (error) => resolve(!error))
    )
    if (opened) return 'code'
    // VS Code is optional, so fall back to the folder rather than failing.
    return (await shell.openPath(path)) ? 'failed' : 'folder'
  })
  ipcMain.handle('terminal:revealDirectory', (_event, path: string) => openPathWith(path))
  ipcMain.handle('terminal:openLink', (_event, url: string) => {
    // Only web links: a terminal can print any string, and openExternal would run other schemes.
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  ipcMain.handle('terminal:listDirectories', (_event, path: string) => listDirectories(path))
}

const appInfoCache = new Map<string, boolean>()

function readsText(appPath: string): Promise<boolean> {
  const cached = appInfoCache.get(appPath)
  if (cached !== undefined) return Promise.resolve(cached)
  return new Promise((resolve) => {
    execFile(
      'plutil',
      ['-convert', 'json', '-o', '-', join(appPath, 'Contents', 'Info.plist')],
      { maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        let result = false
        if (!error) {
          try {
            result = opensTextFiles(JSON.parse(stdout) as AppInfo)
          } catch {
            // An unreadable plist is treated as not a text editor.
          }
        }
        appInfoCache.set(appPath, result)
        resolve(result)
      }
    )
  })
}

/** Names of the installed apps that open text or markdown, for the "Open files with" picker. */
async function listInstalledApps(): Promise<string[]> {
  const found = new Map<string, string>()
  for (const dir of ['/Applications', '/System/Applications', join(homedir(), 'Applications')]) {
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.endsWith('.app')) found.set(entry.slice(0, -4), join(dir, entry))
      }
    } catch {
      // The folder may not exist.
    }
  }
  const names = [...found.keys()]
  const keep = await Promise.all(names.map((name) => readsText(found.get(name)!)))
  return names.filter((_, i) => keep[i]).sort((a, b) => a.localeCompare(b))
}

/**
 * Opens a file or folder in the app chosen in Settings (macOS `open -a`), else the system default.
 * Returns an error string, or '' on success, like `shell.openPath`.
 */
async function openPathWith(path: string): Promise<string> {
  const appName = loadSettings().openFilesWith.trim()
  if (!appName) return shell.openPath(path)
  return new Promise((resolve) => {
    execFile('open', ['-a', appName, path], (error) => {
      if (!error) return resolve('')
      // A mistyped app name should not leave the click doing nothing.
      void shell
        .openPath(path)
        .then((fallback) => resolve(fallback || `Could not open with ${appName}`))
    })
  })
}

/** How long an agent's input box gets to take typed text before Enter arrives. */
const SUBMIT_DELAY_MS = 250

/**
 * Types a request into a running agent and submits it. The text and the Enter go in separate
 * writes: an agent CLI treats a burst that ends in a newline as a paste, and a pasted newline adds
 * a line to its input box instead of sending it, so the request would sit there unsent.
 */
function submitToAgent(sessionId: string, text: string): void {
  writeToSession(sessionId, text)
  setTimeout(() => writeToSession(sessionId, '\r'), SUBMIT_DELAY_MS)
}

/**
 * Asks the agent running a task to open its pull request, by typing the request into its session —
 * the thing a user would otherwise type once a review passes. Only a live, idle agent is asked:
 * text typed at a bare shell would run, and a request queued behind a working agent would surprise.
 */
function askForPullRequest(taskId: string): void {
  const task = findTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)
  const settings = loadSettings()
  const live = findSessionByTask(taskId, settings.activeWorkspaceId)
  const running = live && terminalRuntimeState(live.id)?.runningCommand
  if (!live || !running) throw new Error('This task has no running agent to ask. Resume it first.')
  const state = agentStatuses().find((status) => status.taskId === taskId)?.state
  if (state === 'working' || state === 'waiting')
    throw new Error('The agent is still working on this task. Ask once it stops.')
  const repoPath = task.repoPath || settings.defaultRepoPath.trim()
  const base = task.baseBranch || (repoPath ? baseBranchFor(repoPath) : undefined)
  submitToAgent(live.id, createPullRequestPrompt({ taskFile: task.filePath, base }))
}

/**
 * Starts a fresh reviewer on an In Review task — the launch Orchestrate makes for the review lane.
 * Orchestrate skips a task whose tab is open, but this is asked from that very tab, so an agent that
 * is not mid-turn gives way: its chat stays in the task's history and the reviewer starts clean.
 */
async function askReview(taskId: string): Promise<TerminalSessionInfo> {
  const task = findTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)
  if (task.status !== 'in_review') throw new Error(`${taskId} is not in review`)
  const settings = loadSettings()
  const live = findSessionByTask(taskId, settings.activeWorkspaceId)
  if (live) {
    const state = agentStatuses().find((status) => status.taskId === taskId)?.state
    if (state === 'working' || state === 'waiting')
      throw new Error('The agent is still working on this task. Ask for a review once it stops.')
    killSession(live.id)
  }
  return launchSessionForTask(taskId, {
    withPrompt: true,
    fresh: true,
    provider: providerForLane(settings, 'review')
  })
}

/**
 * Writes a handoff document for a terminal session and opens a Backlog task that points at it, so
 * another agent can pick the work up. The document lives in the workspace folder, not the user's
 * repository, so it never shows up as an untracked file there. The new task is not orchestrated:
 * handing work off should not silently start an agent.
 */
function handOffSession(
  sessionId: string,
  output: string
): { taskId: string; path: string; agentAsked: boolean } {
  const info = listSessions().find((session) => session.id === sessionId)
  if (!info) throw new Error('That terminal session is gone')
  const settings = loadSettings()
  const runtime = terminalRuntimeState(sessionId)
  const cwd = runtime?.cwd || info.cwd
  // Only an agent that is actually running can be asked: text typed at a bare shell would run.
  const running = runtime?.runningCommand?.command
  const agentAsked = Boolean(running && (info.taskId || isAgentProgram(running)))
  const source =
    (info.taskId && info.workspaceId === settings.activeWorkspaceId
      ? findTask(info.taskId)
      : null) ?? undefined
  const branch = readGitBranch(cwd)
  const createdAt = new Date().toISOString()

  const document = renderHandoff({
    source: source && {
      id: source.id,
      title: source.title,
      status: source.status,
      description: source.description,
      activity: source.activity
    },
    cwd,
    branch,
    ...workingTreeSummary(cwd),
    output,
    createdAt,
    awaitingAgentSummary: agentAsked
  })
  const folder = join(workspaceDir(settings), 'handoffs')
  const path = join(folder, handoffFileName(source, createdAt))
  mkdirSync(folder, { recursive: true })
  writeFileSync(path, document, 'utf8')

  // The new worktree starts from the source's branch, so the commits carry over. Uncommitted work
  // does not; the document says where it is.
  const carryBranch = branch?.startsWith(WORKTREE_BRANCH_PREFIX) ? branch : undefined
  const subject = source ? source.title : `work in ${cwd.split('/').pop() || cwd}`
  const task = createTask({
    title: `Continue: ${subject}`,
    description: [
      source
        ? `Pick up ${source.id} where the previous agent stopped.`
        : 'Pick up the work from a terminal session where the previous agent stopped.',
      '',
      `Read the handoff document first: ${path}`
    ].join('\n'),
    status: 'backlog',
    priority: source?.priority ?? 'medium',
    readiness: 'ready',
    tags: [...new Set([...(source?.tags ?? []), 'handoff'])],
    repoPath: source?.repoPath || settings.defaultRepoPath.trim() || undefined,
    baseBranch: carryBranch,
    useWorktree: settings.taskDefaults.useWorktree,
    orchestrate: false,
    contextFiles: [path],
    provider: settings.defaultProvider
  })
  if (source) addNote(source.id, 'styr', `Handed off as ${task.id}; handoff document: ${path}`)
  // Last, so a failure above never leaves the agent writing a document nothing points at.
  if (agentAsked) submitToAgent(sessionId, agentHandoffPrompt(path))
  notifyTasksChanged()
  return { taskId: task.id, path, agentAsked }
}

/** Sub-directories of `path` for the terminal's directory picker; unreadable paths list nothing. */
function listDirectories(path: string): { path: string; parent: string | null; names: string[] } {
  const resolved = resolve(path === '~' ? homedir() : path)
  const parent = dirname(resolved)
  let names: string[] = []
  try {
    names = readdirSync(resolved, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    // Permission denied or the folder vanished: show an empty list rather than failing the picker.
  }
  return { path: resolved, parent: parent === resolved ? null : parent, names }
}

export { broadcast }
