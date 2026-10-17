import { existsSync, readdirSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { app, ipcMain, shell } from 'electron'
import { opensTextFiles, type AppInfo } from '@core/appFilter.js'
import { workspaceDir } from '@core/config.js'
import { loadSettings, persistSettings } from '@core/settingsStore.js'
import type { AgentStatus } from '@core/agentState.js'
import { planLaunch, renderPrompt } from '@core/launch.js'
import { providerFor } from '@core/providers/index.js'
import { z } from 'zod'
import { recordNotifyDuration, stopSampling, takeSnapshot } from './diagnostics.js'
import { terminalEngineDiagnostics } from './terminal/terminalEngines.js'
import type { DiffResult, DiffStat, PatchResult } from '@core/diff.js'
import { findGitRoot, listBranches, readGitBranch } from '@core/worktree.js'
import { taskCheckout, type CheckoutTask, type TaskCheckout } from '@core/taskCheckout.js'
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
import { fetchAndSettle, settleLandedTasks } from './landing.js'
import {
  initSourceSync,
  linkTask,
  listSourceTargets,
  observeTasks,
  refreshTask,
  previewSource,
  resetSourceObserver,
  restartSourcePolling,
  sourceStates,
  syncSource,
  unlinkTask
} from './sourceSync.js'
import { adapterFor, runCommand, sourceProviders } from '@core/sources/index.js'
import { testRestRequest } from '@core/sources/rest.js'
import {
  restSourceSettingsSchema,
  settingsChangeSchema,
  workspaceIdSchema
} from '@core/taskSchema.js'
import type { Task, TaskStatus, WorklogData, WorklogTask } from '@core/types.js'
import { collectWorklog, diskWorklogSources } from '@core/worklogSources.js'
import { createAgentsService, diskAgentStore, diskGit } from '@host/agentsService.js'
import { createDispatchService, diskDispatchSettings, realClock } from '@host/dispatchService.js'
import { createTasksService } from '@host/tasksService.js'
import {
  createWorkspacesService,
  diskWorkspaceStore,
  inOtherWorkspace
} from '@host/workspacesService.js'
import { electronHost, electronWindows } from './electronHost.js'
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
import { publishAgentConversation } from './usage.js'
import { agentCliStatus, ensureAgentCli } from './agentCli.js'
import { mcpEntry } from './mcpEntry.js'
import { resolveShell } from '@core/platformShell.js'

const { broadcast } = electronHost

/**
 * The tasks and workspaces services, wired to main's index, watchers and the services not yet in
 * `src/host/`. Created before the agents service below, which takes their functions as ports.
 */
const tasksService = createTasksService({
  broadcast,
  index: { sync: syncIndex, query: queryTasks, find: findTask },
  store: {
    createTask,
    updateTask,
    addNote,
    reorderTasks,
    setArchived,
    deleteTask,
    removeWorktree: (task) => activeTaskCheckout(task).removeWorktree(),
    brokenTaskFiles
  },
  settleLandedTasks,
  observeTasks,
  recordNotifyDuration,
  requestAutoRun: () => dispatchService.requestAutoRun(),
  notifyAgents: notifyAgentsChanged
})

const workspacesService = createWorkspacesService({
  broadcast,
  trashItem: electronHost.trashItem,
  store: diskWorkspaceStore,
  activeTasks: () => queryTasks(),
  liveSessions: () => listSessions(),
  activity: () => agentsService.activity(),
  resetSources: resetSourceObserver,
  restartSourcePolling,
  closeIndex,
  startTaskWatcher: () => startWatching(() => notifyTasksChanged()),
  startAgentWatcher: () => startWatchingAgents(() => notifyAgentsChanged()),
  notifyTasks: notifyTasksChanged,
  notifyAgents: notifyAgentsChanged
})

export { inOtherWorkspace }

export function notifyTasksChanged(): void {
  tasksService.notifyTasksChanged()
}

export function switchWorkspace(id: string): void {
  workspacesService.switchWorkspace(id)
}

/**
 * The agents service, created here so the Codex monitor it makes comes up when `ipc.ts` loads, as
 * it always has: after the tasks and workspaces services, before Auto-run.
 */
const agentsService = createAgentsService({
  broadcast,
  store: diskAgentStore,
  git: diskGit,
  tasks: {
    query: () => queryTasks(),
    findTask,
    getTask,
    updateTask,
    addNote,
    createTask,
    setArchived,
    removeAgent: (taskId) => tasksService.removeAgent(taskId)
  },
  notifyTasks: notifyTasksChanged,
  pinWorkspace: inOtherWorkspace,
  terminals: {
    createSession,
    findSessionByTask,
    listSessions,
    killSession,
    writeToSession,
    runtimeState: terminalRuntimeState
  },
  createMonitor: (onUpdate, onConversation) => new CodexMonitor(onUpdate, onConversation),
  publishConversation: publishAgentConversation,
  ensureAgentCli,
  prepareCodex,
  planLaunch,
  updateTray,
  requestAutoRun: () => dispatchService.requestAutoRun()
})

export function agentStatuses(): AgentStatus[] {
  return agentsService.agentStatuses()
}

/** Without a workspace, the exit is the active workspace's. */
export function markAgentExited(taskId: string, workspaceId?: string): void {
  agentsService.markAgentExited(taskId, workspaceId)
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
  agentsService.notifyAgentsChanged()
}

/** A task's checkout in the active workspace, placed by that workspace's `worktreeLocation`. */
function activeTaskCheckout(task: CheckoutTask): TaskCheckout {
  const { activeWorkspaceId, worktreeLocation } = loadSettings()
  return taskCheckout(activeWorkspaceId, task, worktreeLocation)
}

let diffStatsRun: Promise<Record<string, DiffStat>> | undefined

/**
 * Per-task change totals for the cards. The git work is synchronous, so the loop yields between
 * tasks (~0.2s each): IPC, the watcher and the terminals keep being served in the gaps.
 */
async function computeDiffStats(): Promise<Record<string, DiffStat>> {
  const { activeWorkspaceId: workspaceId, worktreeLocation } = loadSettings()
  const stats: Record<string, DiffStat> = {}
  for (const task of queryTasks()) {
    // Done work has landed (or is being cleaned up); a count there is noise.
    const { repoPath } = task
    if (!task.worktreePath || !repoPath || task.status === 'done' || task.archivedAt) continue
    await new Promise((resolve) => setImmediate(resolve))
    const diff = taskCheckout(workspaceId, { ...task, repoPath }, worktreeLocation).diff()
    if ('error' in diff || diff.kind !== 'changes') continue
    stats[task.id] = {
      added: diff.totalAdditions,
      removed: diff.totalDeletions,
      files: diff.totalFiles
    }
  }
  return stats
}

/**
 * The Worklog for `[from, to)`: each task's sessions and the tokens their transcripts record. On
 * demand only, never from `notifyTasksChanged`; the loop yields between tasks like the diff stats.
 */
async function loadWorklog(from: number, to: number): Promise<WorklogData> {
  const tasks: WorklogTask[] = []
  for (const task of queryTasks()) {
    await new Promise((resolve) => setImmediate(resolve))
    tasks.push(...collectWorklog([task], from, to, diskWorklogSources))
  }
  return { tasks }
}

/**
 * Fetches `origin` where In Review work waits to land, then settles what landed — how a PR merged
 * on the host is noticed. Event-driven only (window focus, a Dispatch run, an Auto-run pass, the
 * palette), throttled and coalesced per repository, and never part of `notifyTasksChanged`.
 */
export async function checkForMergedWork(): Promise<void> {
  try {
    if (await fetchAndSettle()) notifyTasksChanged()
  } catch (error) {
    console.warn('landing: checking for merged work failed:', error)
  }
}

/**
 * Dispatch and Auto-run, created after the agents service, whose launch and agent rows it plans
 * and starts with. The tasks and agents services request Auto-run through it lazily.
 */
const dispatchService = createDispatchService({
  broadcast,
  notify: electronHost.notify,
  settings: diskDispatchSettings,
  tasks: { query: () => queryTasks(), addNote },
  liveSessions: () => listSessions(),
  agentStatuses,
  launch: agentsService.launch,
  checkForMergedWork,
  clock: realClock
})

/** Called once the window is up: after the startup grace Auto-run evaluates the board. */
export function startAutoDispatch(): void {
  dispatchService.startAutoRun()
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
  // sends the request as edited, unsaved; external sources are experimental, so only with the flag on
  ipcMain.handle('sources:restTest', (_event, settings: unknown) => {
    if (!loadSettings().experimental.externalSources)
      throw new Error('Turn on External sources in Settings → Experimental first.')
    return testRestRequest(restSourceSettingsSchema.parse(settings))
  })
  ipcMain.handle('sources:targets', (_event, sourceId: string) =>
    listSourceTargets(String(sourceId))
  )
  ipcMain.handle('sources:sync', (_event, sourceId: string) => syncSource(String(sourceId)))
  ipcMain.handle('sources:preview', (_event, sourceId: string) => previewSource(String(sourceId)))
  ipcMain.handle('sources:apply', (_event, sourceId: string, itemIds: unknown) =>
    syncSource(String(sourceId), z.array(z.string()).parse(itemIds))
  )
  ipcMain.handle('sources:link', (_event, taskId: string, text: string) =>
    linkTask(String(taskId), String(text))
  )
  ipcMain.handle('sources:unlink', (_event, taskId: string) => unlinkTask(String(taskId)))
  ipcMain.handle('sources:refresh', (_event, taskId: string) => refreshTask(String(taskId)))
  ipcMain.handle('tasks:list', (_event, filter: unknown) => tasksService.list(filter))
  ipcMain.handle('tasks:get', (_event, id: string) => tasksService.get(id))
  ipcMain.handle('tasks:problems', () => tasksService.problems())

  ipcMain.handle('tasks:removeWorktree', (_event, taskId: string) =>
    tasksService.removeWorktree(taskId)
  )
  ipcMain.handle('git:branches', (_event, repoPath: string) => listBranches(repoPath))
  ipcMain.handle('git:taskDiff', (_event, taskId: unknown): DiffResult => {
    const task = diffTask(taskId)
    if ('error' in task) return task
    return activeTaskCheckout(task).diff()
  })
  ipcMain.handle(
    'git:filePatch',
    (_event, taskId: unknown, path: unknown, full?: unknown): PatchResult => {
      const task = diffTask(taskId)
      if ('error' in task) return task
      const file = z.string().min(1).safeParse(path)
      if (!file.success) return { error: 'Invalid path' }
      return activeTaskCheckout(task).filePatch(file.data, full === true)
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
  ipcMain.handle('worklog:load', (_event, from: unknown, to: unknown) => {
    const span = z
      .object({ from: z.number().finite(), to: z.number().finite() })
      .parse({ from, to })
    return loadWorklog(span.from, span.to)
  })

  ipcMain.handle('tasks:create', (_event, draft: unknown) => tasksService.create(draft))
  ipcMain.handle('tasks:update', (_event, id: string, patch: unknown) =>
    tasksService.update(id, patch)
  )
  ipcMain.handle('tasks:note', (_event, id: string, author: string, message: string) =>
    tasksService.note(id, author, message)
  )
  ipcMain.handle('tasks:reorder', (_event, status: TaskStatus, orderedIds: string[]) =>
    tasksService.reorder(status, orderedIds)
  )
  ipcMain.handle('tasks:archive', (_event, id: string, archived: boolean) =>
    tasksService.archive(id, archived)
  )
  ipcMain.handle('tasks:delete', (_event, id: string) => tasksService.delete(id))

  ipcMain.handle('tasks:reveal', (_event, id: string) => {
    const task = tasksService.get(id)
    if (task) shell.showItemInFolder(task.filePath)
  })

  ipcMain.handle('tasks:openInEditor', (_event, id: string) => {
    const task = tasksService.get(id)
    if (task) void openPathWith(task.filePath)
  })

  ipcMain.handle('diagnostics:snapshot', () =>
    takeSnapshot({
      terminals: listSessions().length,
      taskCount: queryTasks().length,
      terminalEngine: terminalEngineDiagnostics()
    })
  )
  ipcMain.handle('diagnostics:stop', () => stopSampling())
  ipcMain.handle('app:info', () => ({ isPackaged: app.isPackaged, version: app.getVersion() }))
  ipcMain.on('app:titleBarColors', (event, background: string, symbols: string) => {
    // macOS draws traffic lights, not an overlay; Windows and Linux both use the overlay.
    if (process.platform === 'darwin') return
    electronWindows.setTitleBarOverlay(event.sender, {
      color: String(background),
      symbolColor: String(symbols)
    })
  })

  ipcMain.handle('app:mcpCommand', (_event, provider?: 'claude' | 'codex') => {
    const entry = mcpEntry()
    return providerFor({
      ...loadSettings(),
      defaultProvider: provider ?? 'claude'
    }).mcpInstallCommand(entry, resolveShell(loadSettings().shell).syntax)
  })

  ipcMain.handle('orchestrate:plan', () => dispatchService.plan())
  ipcMain.handle('tasks:checkMerged', () => checkForMergedWork())

  ipcMain.handle('orchestrate:run', (_event, taskIds?: string[]) => dispatchService.run(taskIds))
  ipcMain.handle('orchestrate:autoState', () => dispatchService.autoState())
  ipcMain.handle('orchestrate:autoSet', (_event, on: unknown) => dispatchService.autoSet(on))

  ipcMain.handle('settings:get', (_event, workspaceId: unknown) =>
    loadSettings(workspaceIdSchema.optional().parse(workspaceId))
  )
  ipcMain.handle('settings:save', (_event, change: unknown) => {
    const parsed = settingsChangeSchema.parse(change)
    const folderBefore = workspaceDir(loadSettings())
    try {
      persistSettings(parsed)
    } finally {
      workspacesService.afterSettingsSave(folderBefore, parsed.workspaceId)
      dispatchService.autoRunFlagChanged()
    }
    return loadSettings()
  })
  ipcMain.handle('settings:brokenFiles', () => workspacesService.brokenSettingsFiles())

  ipcMain.handle('workspaces:list', () => workspacesService.overview())
  ipcMain.handle('workspaces:activity', () => workspacesService.activity())
  ipcMain.handle('workspaces:boardSummary', () => workspacesService.boardSummaries())
  ipcMain.handle('workspaces:switch', (_event, id: string) => workspacesService.switch(id))
  ipcMain.handle('workspaces:create', (_event, name: string) => workspacesService.create(name))
  ipcMain.handle('workspaces:rename', (_event, id: string, name: string) =>
    workspacesService.rename(id, name)
  )
  ipcMain.handle('workspaces:delete', (_event, id: string) => workspacesService.delete(id))

  ipcMain.handle('settings:pickDirectory', async (event, current?: string) => {
    const picked = await electronWindows.showOpenDialog(event.sender, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current
    })
    return picked?.[0] ?? null
  })

  ipcMain.handle('settings:listApps', () => listInstalledApps())
  ipcMain.handle(
    'agents:cliStatus',
    (_event, provider: 'claude' | 'codex', command: string, shell: string) =>
      agentCliStatus({ provider, command: String(command ?? ''), shell: String(shell ?? '') })
  )

  ipcMain.handle('settings:pickApp', async (event) => {
    const windows = process.platform === 'win32'
    const linux = process.platform === 'linux'
    const result = await electronWindows.showOpenDialog(event.sender, {
      properties: ['openFile'],
      defaultPath: windows ? process.env.ProgramFiles : linux ? '/usr/bin' : '/Applications',
      // Linux programs have no extension to filter on.
      filters: windows
        ? [{ name: 'Programs', extensions: ['exe'] }]
        : linux
          ? []
          : [{ name: 'Applications', extensions: ['app'] }]
    })
    const picked = result?.[0]
    // Windows and Linux have no `open -a`, so the program is kept by path and run directly.
    if (!picked) return null
    return process.platform === 'darwin' ? basename(picked, '.app') : picked
  })

  ipcMain.handle('settings:pickFiles', async (event, startIn?: string) => {
    const picked = await electronWindows.showOpenDialog(event.sender, {
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      defaultPath: startIn || loadSettings().defaultRepoPath || undefined
    })
    return picked ?? []
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
      agentsService.launch(taskId, { templateId, provider })
  )

  ipcMain.handle('terminal:resumeSession', (_event, taskId: string, sessionId: string) =>
    agentsService.resume(taskId, sessionId)
  )

  ipcMain.handle('tasks:forgetSession', (_event, taskId: string) =>
    tasksService.forgetSession(taskId)
  )

  ipcMain.handle('agents:remove', (_event, taskId: unknown) =>
    agentsService.remove(z.string().min(1).parse(taskId))
  )

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
    agentsService.askForPullRequest(taskId)
  )
  ipcMain.handle('terminal:askReview', (_event, taskId: string) => agentsService.askReview(taskId))
  ipcMain.handle('terminal:askFork', (_event, sessionId: string, question: string) =>
    agentsService.askFork(sessionId, String(question ?? ''))
  )
  ipcMain.handle('terminal:handOff', (_event, sessionId: string, output: string) =>
    agentsService.handOff(sessionId, String(output ?? ''))
  )
  ipcMain.handle('terminal:gitContext', (_event, path: string) => {
    const root = findGitRoot(path)
    return { root: root ?? null, branch: (root && readGitBranch(root)) ?? null }
  })
  ipcMain.handle('terminal:openInCode', async (_event, path: string) => {
    const opened =
      process.platform === 'win32'
        ? await launchDetached(findVsCodeWindows(), path)
        : process.platform === 'linux'
          ? await launchDetached('code', path)
          : await new Promise<boolean>((resolve) =>
              execFile('open', ['-a', 'Visual Studio Code', path], (error) => resolve(!error))
            )
    if (opened) return 'code'
    // VS Code is optional, so fall back to the folder rather than failing.
    return (await shell.openPath(path)) ? 'failed' : 'folder'
  })
  // Always Finder: "Open files with" is for task files, and an editor there would swallow folders.
  ipcMain.handle('terminal:revealDirectory', (_event, path: string) => shell.openPath(path))
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
 * Opens a file or folder in the app chosen in Settings (macOS `open -a`; on Windows and Linux the
 * program's path), else the system default. Returns an error string, or '' on success, like `shell.openPath`.
 */
async function openPathWith(path: string): Promise<string> {
  const appName = loadSettings().openFilesWith.trim()
  if (!appName) return shell.openPath(path)
  if (process.platform !== 'darwin') {
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
