import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  shell,
  type OpenDialogOptions
} from 'electron'
import { opensTextFiles, type AppInfo } from '@core/appFilter.js'
import { pathsInWorkspace, pinWorkspace, workspaceDir } from '@core/config.js'
import {
  isSettingsFileBroken,
  loadSettings,
  persistSettings,
  saveGlobalSettings,
  saveWorkspaceSettings,
  settingsFilePath
} from '@core/settingsStore.js'
import { clearAgentStatus, readAllAgentStatuses, recordAgentEvent } from '@core/agentStore.js'
import type { AgentStatus } from '@core/agentState.js'
import { planLaunch, renderPrompt, workingDirFor } from '@core/launch.js'
import { isPlanRun } from '@core/planning.js'
import { providerFor } from '@core/providers/index.js'
import { z } from 'zod'
import { recordNotifyDuration, stopSampling, takeSnapshot } from './diagnostics.js'
import type { DiffResult, DiffStat, PatchResult } from '@core/diff.js'
import {
  findGitRoot,
  baseBranchFor,
  listBranches,
  readGitBranch,
  removeWorktree,
  type Checkout
} from '@core/worktree.js'
import { taskDiff, taskFilePatch, workingTreeSummary } from '@core/worktreeDiff.js'
import { createSessionLifecycle, monitorKey } from '@core/sessionLifecycle.js'
import { buildTrayModel, createWorkspaceSession } from '@core/workspaceSession.js'
import {
  createWorkspace,
  listWorkspaces,
  readBackgroundAgents,
  renameWorkspace,
  workspaceTaskCount
} from '@core/workspaces.js'
import { createAutoDispatch } from '@core/autoDispatchRunner.js'
import { planOrchestration, providerForLane, type OrchestrationPlan } from '@core/orchestrate.js'
import {
  globalSettingsFor,
  workspaceSettingsFor,
  worktreeKey,
  type AutoDispatchPause,
  type BrokenSettingsFile,
  type OrchestrationLane,
  type OrchestrationSummary,
  type TerminalSessionInfo,
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
  initSourceSync,
  linkTask,
  listSourceTargets,
  observeTasks,
  refreshTask,
  resetSourceObserver,
  restartSourcePolling,
  sourceStates,
  syncSource,
  unlinkTask
} from './sourceSync.js'
import { adapterFor, runCommand, sourceProviders } from '@core/sources/index.js'
import {
  taskDraftSchema,
  taskFilterSchema,
  taskPatchSchema,
  settingsChangeSchema,
  workspaceIdSchema
} from '@core/taskSchema.js'
import { TASK_STATUSES, type Task, type TaskStatus } from '@core/types.js'
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
import { CodexMonitor, prepareCodex } from './codexMonitor.js'
import { agentCliStatus, ensureAgentCli } from './agentCli.js'
import { resolveShell } from '@core/platformShell.js'

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

/**
 * Turns the Codex daemon's lifecycle broadcasts into the same agent records a Claude hook writes,
 * so the sidebar, tray and terminal dots need no Codex-specific code. The lifecycle is created
 * below; updates only arrive after the module has loaded.
 */
const codexMonitor = new CodexMonitor((update) => lifecycle.recordCodexUpdate(update))

/** Agents the user removed while live: their terminal's exit must not write a status back. */
const removedWhileLive = new Set<string>()

export function markAgentExited(
  taskId: string,
  workspaceId = loadSettings().activeWorkspaceId
): void {
  codexMonitor.release(monitorKey(workspaceId, taskId))
  if (removedWhileLive.delete(monitorKey(workspaceId, taskId))) {
    notifyAgentsChanged()
    return
  }
  recordAgentEvent(pathsInWorkspace(loadSettings(), workspaceId), taskId, 'TerminalExit')
  archivePlanRun(taskId, workspaceId)
  notifyAgentsChanged()
}

/** A ⌘↵ planning run leaves no card behind: its throwaway task is archived when the session ends. */
function archivePlanRun(taskId: string, workspaceId: string): void {
  try {
    const archived = inOtherWorkspace(workspaceId, () => {
      const task = getTask(taskId)
      if (!task || !isPlanRun(task) || task.archivedAt) return false
      setArchived(taskId, true)
      return true
    })
    if (archived) notifyTasksChanged()
  } catch (error) {
    console.error('Could not archive the planning run:', error)
  }
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
  const model = buildTrayModel(
    settings,
    listWorkspaces(settings),
    statuses,
    queryTasks(),
    readBackgroundAgents(settings, settings.activeWorkspaceId)
  )
  updateTray(model.statuses, model.titles)
  autoDispatch.request()
}

let diffStatsRun: Promise<Record<string, DiffStat>> | undefined

function checkoutOf(
  task: { id: string; baseBranch?: string },
  repoPath: string,
  workspaceId: string
): Checkout {
  return { repoPath, key: worktreeKey(workspaceId, task.id), baseBranch: task.baseBranch }
}

/**
 * Per-task change totals for the cards. The git work is synchronous, so the loop yields between
 * tasks (~0.2s each): IPC, the watcher and the terminals keep being served in the gaps.
 */
async function computeDiffStats(): Promise<Record<string, DiffStat>> {
  const workspaceId = loadSettings().activeWorkspaceId
  const stats: Record<string, DiffStat> = {}
  for (const task of queryTasks()) {
    // Done work has landed (or is being cleaned up); a count there is noise.
    if (!task.worktreePath || !task.repoPath || task.status === 'done' || task.archivedAt) continue
    await new Promise((resolve) => setImmediate(resolve))
    const diff = taskDiff(checkoutOf(task, task.repoPath, workspaceId), task.useWorktree !== false)
    if ('error' in diff || diff.kind !== 'changes') continue
    stats[task.id] = {
      added: diff.totalAdditions,
      removed: diff.totalDeletions,
      files: diff.totalFiles
    }
  }
  return stats
}

export function notifyTasksChanged(): void {
  const started = performance.now()
  syncIndex()
  if (settleLandedTasks()) syncIndex()
  observeTasks(queryTasks())
  recordNotifyDuration(performance.now() - started)
  broadcast('tasks:changed')
  autoDispatch.request()
}

const lifecycle = createSessionLifecycle({
  settings: loadSettings,
  findTask,
  getTask,
  updateTask,
  addNote,
  createTask,
  notifyTasks: notifyTasksChanged,
  notifyAgents: notifyAgentsChanged,
  recordAgentEvent: (workspaceId, taskId, event) =>
    recordAgentEvent(pathsInWorkspace(loadSettings(), workspaceId), taskId, event),
  pinWorkspace: inOtherWorkspace,
  createSession,
  findSessionByTask,
  listSessions,
  killSession,
  writeToSession,
  runtimeState: terminalRuntimeState,
  agentStatuses,
  monitor: codexMonitor,
  ensureAgentCli,
  prepareCodex,
  planLaunch,
  git: {
    branch: readGitBranch,
    baseBranch: baseBranchFor,
    workingTree: workingTreeSummary
  },
  writeHandoff: (fileName, content) => {
    const folder = join(workspaceDir(loadSettings()), 'handoffs')
    const path = join(folder, fileName)
    mkdirSync(folder, { recursive: true })
    writeFileSync(path, content, 'utf8')
    return path
  }
})

const launchSessionForTask = lifecycle.startForTask

function buildPlan(skip?: ReadonlySet<string>): OrchestrationPlan {
  const active = loadSettings().activeWorkspaceId
  const liveTaskIds = new Set(
    listSessions()
      .filter((session) => session.workspaceId === active)
      .map((session) => session.taskId)
      .filter(Boolean) as string[]
  )
  const agents = new Map(agentStatuses().map((status) => [status.taskId, status.state]))
  return planOrchestration(loadSettings(), queryTasks(), { liveTaskIds, agents, skip })
}

/** Starts one planned task the way Dispatch does, whether a person or Auto-run asked. */
function dispatchTask(task: Task, lane: OrchestrationLane): Promise<TerminalSessionInfo> {
  return launchSessionForTask(task.id, {
    withPrompt: true,
    fresh: lane === 'review',
    provider: providerForLane(loadSettings(), lane)
  })
}

const PAUSE_MESSAGES: Record<AutoDispatchPause, string> = {
  limit: 'Auto-run started too many tasks in an hour and has switched itself off.',
  failures: 'Auto-run switched itself off after three launches in a row failed.'
}

/** The flag is a workspace setting, so it is written to the active workspace's own file. */
function writeAutoDispatchFlag(on: boolean): void {
  const settings = loadSettings()
  if (settings.autoDispatch === on) return
  saveWorkspaceSettings({ ...settings, autoDispatch: on }, settings.activeWorkspaceId)
  broadcast('settings:changed', loadSettings())
}

const autoDispatch = createAutoDispatch({
  enabled: () => loadSettings().autoDispatch,
  setEnabled: writeAutoDispatchFlag,
  workspaceId: () => loadSettings().activeWorkspaceId,
  snapshot: (skip) => ({ plan: buildPlan(skip), tasks: queryTasks() }),
  launch: async (task, lane) => {
    // The renderer only learns of sessions it asked for, so tell it about this one.
    broadcast('orchestrate:autoStarted', await dispatchTask(task, lane))
  },
  noteFailure: (task, error) => {
    const message = error instanceof Error ? error.message : String(error)
    try {
      addNote(task.id, 'styr', `Auto-run could not start this task: ${message}`)
    } catch {
      // The task may have been deleted meanwhile; there is nothing to note it on.
    }
  },
  paused: (reason) => {
    if (Notification.isSupported()) {
      new Notification({ title: 'Styr', body: PAUSE_MESSAGES[reason] }).show()
    }
  },
  stateChanged: (state) => broadcast('orchestrate:autoState', state),
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
})

/** Called once the window is up: after the startup grace Auto-run evaluates the board. */
export function startAutoDispatch(): void {
  autoDispatch.start()
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
    blocked: plan.blocked,
    missingWorkingDir: plan.missingWorkingDir,
    idleSessions: plan.idleSessions
  }
}

const workspaceSession = createWorkspaceSession({
  loadSettings,
  listWorkspaces,
  workspaceDir,
  saveActiveWorkspace: (settings, id) =>
    saveGlobalSettings({ ...globalSettingsFor(settings), activeWorkspaceId: id }),
  resetSources: resetSourceObserver,
  restartSourcePolling,
  closeIndex,
  startTaskWatcher: () => startWatching(() => notifyTasksChanged()),
  startAgentWatcher: () => startWatchingAgents(() => notifyAgentsChanged()),
  notifyTasks: notifyTasksChanged,
  notifyAgents: notifyAgentsChanged,
  broadcast,
  hasLiveSessions: (id) => listSessions().some((session) => session.workspaceId === id),
  trash: (path) => shell.trashItem(path)
})

export const switchWorkspace = workspaceSession.switchWorkspace

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

export function registerIpcHandlers(): void {
  initSourceSync({
    onTasksChanged: notifyTasksChanged,
    onState: (states) => broadcast('sources:state', states)
  })
  restartSourcePolling()
  ipcMain.handle('sources:providers', () => sourceProviders())
  ipcMain.handle('sources:ghStatus', () => adapterFor('github')!.status(runCommand))
  ipcMain.handle('sources:state', () => sourceStates())
  ipcMain.handle('sources:targets', (_event, sourceId: string) =>
    listSourceTargets(String(sourceId))
  )
  ipcMain.handle('sources:sync', (_event, sourceId: string) => syncSource(String(sourceId)))
  ipcMain.handle('sources:link', (_event, taskId: string, text: string) =>
    linkTask(String(taskId), String(text))
  )
  ipcMain.handle('sources:unlink', (_event, taskId: string) => unlinkTask(String(taskId)))
  ipcMain.handle('sources:refresh', (_event, taskId: string) => refreshTask(String(taskId)))
  ipcMain.handle('tasks:list', (_event, filter: unknown) =>
    queryTasks(taskFilterSchema.parse(filter ?? {}))
  )
  ipcMain.handle('tasks:get', (_event, id: string) => findTask(id))
  ipcMain.handle('tasks:problems', () => brokenTaskFiles())

  ipcMain.handle('tasks:removeWorktree', (_event, taskId: string) => {
    const task = findTask(taskId)
    if (!task?.repoPath) return null
    removeWorktree(checkoutOf(task, task.repoPath, loadSettings().activeWorkspaceId))
    const updated = updateTask(task.id, { worktreePath: undefined })
    notifyTasksChanged()
    return updated
  })
  ipcMain.handle('git:branches', (_event, repoPath: string) => listBranches(repoPath))
  ipcMain.handle('git:taskDiff', (_event, taskId: unknown): DiffResult => {
    const task = diffTask(taskId)
    if ('error' in task) return task
    return taskDiff(
      checkoutOf(task, task.repoPath, loadSettings().activeWorkspaceId),
      task.useWorktree !== false
    )
  })
  ipcMain.handle(
    'git:filePatch',
    (_event, taskId: unknown, path: unknown, full?: unknown): PatchResult => {
      const task = diffTask(taskId)
      if ('error' in task) return task
      const file = z.string().min(1).safeParse(path)
      if (!file.success) return { error: 'Invalid path' }
      return taskFilePatch(
        checkoutOf(task, task.repoPath, loadSettings().activeWorkspaceId),
        task.useWorktree !== false,
        file.data,
        full === true
      )
    }
  )
  ipcMain.handle('git:diffStats', () => {
    // One run at a time: a burst of task changes must not stack up a queue of full git passes.
    diffStatsRun ??= computeDiffStats().finally(() => {
      diffStatsRun = undefined
    })
    return diffStatsRun
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

  ipcMain.handle('diagnostics:snapshot', () =>
    takeSnapshot({ terminals: listSessions().length, taskCount: queryTasks().length })
  )
  ipcMain.handle('diagnostics:stop', () => stopSampling())
  ipcMain.handle('app:info', () => ({ isPackaged: app.isPackaged, version: app.getVersion() }))
  ipcMain.on('app:titleBarColors', (event, background: string, symbols: string) => {
    if (process.platform !== 'win32') return
    BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay({
      color: String(background),
      symbolColor: String(symbols)
    })
  })

  ipcMain.handle('app:mcpCommand', (_event, provider?: 'claude' | 'codex') => {
    const root = app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked')
      : app.getAppPath()
    const entry = join(root, 'out', 'main', 'mcp', 'index.mjs')
    return providerFor({
      ...loadSettings(),
      defaultProvider: provider ?? 'claude'
    }).mcpInstallCommand(entry, resolveShell(loadSettings().shell).syntax)
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
          session: await dispatchTask(task, lane)
        }))
    )
  })

  ipcMain.handle('orchestrate:autoState', () => autoDispatch.state())
  ipcMain.handle('orchestrate:autoSet', (_event, on: unknown) => {
    writeAutoDispatchFlag(z.boolean().parse(on))
    autoDispatch.enabledChanged()
    return autoDispatch.state()
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
      workspaceSession.afterSettingsSave(folderBefore, parsed.workspaceId)
      autoDispatch.enabledChanged()
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
    // A new board starts with Auto-run off whatever the one it was copied from does.
    const created = createWorkspace(settings, String(name), {
      ...workspaceSettingsFor(settings),
      autoDispatch: false
    })
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
    await workspaceSession.deleteWorkspace(id)
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
  ipcMain.handle(
    'agents:cliStatus',
    (_event, provider: 'claude' | 'codex', command: string, shell: string) =>
      agentCliStatus({ provider, command: String(command ?? ''), shell: String(shell ?? '') })
  )

  ipcMain.handle('settings:pickApp', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const windows = process.platform === 'win32'
    const options: OpenDialogOptions = {
      properties: ['openFile'],
      defaultPath: windows ? process.env.ProgramFiles : '/Applications',
      filters: [
        windows
          ? { name: 'Programs', extensions: ['exe'] }
          : { name: 'Applications', extensions: ['app'] }
      ]
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const picked = result.canceled ? undefined : result.filePaths[0]
    // Windows has no `open -a`, so the program is kept by path and run directly.
    if (!picked) return null
    return windows ? picked : basename(picked, '.app')
  })

  ipcMain.handle('settings:pickFiles', async (event, startIn?: string) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      properties: ['openFile', 'openDirectory', 'multiSelections'],
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
    await ensureAgentCli(plan.provider, settings)
    if (plan.provider === 'codex') await prepareCodex(settings.codexCommand, settings.shell)
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

  // Removes the agent from the board: ends its live terminal, drops its status and forgets the
  // current chat. The chat history on the task stays.
  ipcMain.handle('agents:remove', (_event, taskId: unknown) => {
    const id = z.string().min(1).parse(taskId)
    const settings = loadSettings()
    const workspaceId = settings.activeWorkspaceId
    const live = findSessionByTask(id, workspaceId)
    if (live) {
      removedWhileLive.add(monitorKey(workspaceId, id))
      killSession(live.id)
    }
    codexMonitor.release(monitorKey(workspaceId, id))
    clearAgentStatus(settings, id)
    const task = findTask(id)
    if (task?.agentSession) updateTask(id, { agentSession: undefined })
    notifyTasksChanged()
    notifyAgentsChanged()
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
  ipcMain.handle('terminal:createPr', (_event, taskId: string) =>
    lifecycle.askForPullRequest(taskId)
  )
  ipcMain.handle('terminal:askReview', (_event, taskId: string) => lifecycle.askReview(taskId))
  ipcMain.handle('terminal:askFork', (_event, sessionId: string, question: string) =>
    lifecycle.askFork(sessionId, String(question ?? ''))
  )
  ipcMain.handle('terminal:handOff', (_event, sessionId: string, output: string) =>
    lifecycle.handOff(sessionId, String(output ?? ''))
  )
  ipcMain.handle('terminal:gitContext', (_event, path: string) => {
    const root = findGitRoot(path)
    return { root: root ?? null, branch: (root && readGitBranch(root)) ?? null }
  })
  ipcMain.handle('terminal:openInCode', async (_event, path: string) => {
    const opened =
      process.platform === 'win32'
        ? await launchDetached(findVsCodeWindows(), path)
        : await new Promise<boolean>((resolve) =>
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

/**
 * Starts a GUI program on `path` without tying it to Styr's lifetime. Resolves once it has started
 * (true) or failed to (false) — not when it exits, as `execFile` would.
 */
function launchDetached(program: string | undefined, path: string): Promise<boolean> {
  if (!program) return Promise.resolve(false)
  return new Promise((resolve) => {
    const child = spawn(program, [path], { detached: true, stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}

/** VS Code's own executable: the per-user install first, then the system-wide one. */
function findVsCodeWindows(): string | undefined {
  const { LOCALAPPDATA, ProgramFiles } = process.env
  return [
    LOCALAPPDATA && join(LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    ProgramFiles && join(ProgramFiles, 'Microsoft VS Code', 'Code.exe')
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)))
}

/**
 * Names of the installed apps that open text or markdown, for the "Open files with" picker. Reads
 * macOS bundles only; on Windows the picker offers "Other…" to browse for a program.
 */
async function listInstalledApps(): Promise<string[]> {
  if (process.platform !== 'darwin') return []
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
 * Opens a file or folder in the app chosen in Settings (macOS `open -a`; on Windows the program's
 * path), else the system default. Returns an error string, or '' on success, like `shell.openPath`.
 */
async function openPathWith(path: string): Promise<string> {
  const appName = loadSettings().openFilesWith.trim()
  if (!appName) return shell.openPath(path)
  if (process.platform === 'win32') {
    if (await launchDetached(appName, path)) return ''
    const fallback = await shell.openPath(path)
    return fallback || `Could not open with ${appName}`
  }
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
