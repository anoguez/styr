import { existsSync, readdirSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { app, ipcMain as electronIpcMain, shell } from 'electron'
import { opensTextFiles, type AppInfo } from '@core/appFilter.js'
import { loadSettings, saveGlobalSettings } from '@core/settingsStore.js'
import { workspaceDir } from '@core/config.js'
import type { AgentStatus } from '@core/agentState.js'
import { planLaunch } from '@core/launch.js'
import { z } from 'zod'
import { recordNotifyDuration, stopSampling, takeSnapshot } from './diagnostics.js'
import { terminalEngineDiagnostics } from './terminal/terminalEngines.js'
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
  applySource,
  ghStatus,
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
  testRestSource,
  unlinkTask
} from './sourceSync.js'
import { sourceProviders } from '@core/sources/index.js'
import type { AutoDispatchState, TaskStatus, TrayCommand } from '@core/types.js'
import { diskWorklogSources } from '@core/worklogSources.js'
import { createAgentsService, diskAgentStore, diskGit } from '@host/agentsService.js'
import { createDispatchService, diskDispatchSettings, realClock } from '@host/dispatchService.js'
import { createGitService, diskRepoGit, nextTurn } from '@host/gitService.js'
import { landingRequests, mergedWorkCheck } from '@host/landing.js'
import { createSettingsService, diskSettingsStore } from '@host/settingsService.js'
import { createTasksService } from '@host/tasksService.js'
import { createWorklogService } from '@host/worklogService.js'
import { createReviewService, diskReviewStore } from '@host/reviewService.js'
import { listDirectories } from '@host/directories.js'
import { createTerminalTabsService, diskTabsStore } from '@host/terminalTabs.js'
import { listWorkspaces } from '@core/workspaces.js'
import {
  createWorkspacesService,
  diskWorkspaceStore,
  inOtherWorkspace
} from '@host/workspacesService.js'
import { electronHost, electronWindows } from './electronHost.js'
import { closeIndex, findTask, queryTasks, syncIndex } from './taskIndex.js'
import { startWatching, startWatchingAgents } from './watcher.js'
import {
  createSession,
  findSessionByTask,
  killSession,
  listSessions,
  onTerminalCreated,
  onTerminalExit,
  resizeSession,
  sessionBacklog,
  terminalRuntimeState,
  writeToSession,
  type SpawnOptions
} from './terminal/ptyManager.js'
import { CodexMonitor, prepareCodex } from './codexMonitor.js'
import { agentPrompts, publishAgentConversation } from './usage.js'
import { agentCliStatus, ensureAgentCli } from './agentCli.js'
import { mcpEntry } from './mcpEntry.js'
import { bindGlobalSettingsSave, remoteRouter, routedIpcMain, startRemote } from './remote.js'
import { isWebLink } from './windowSecurity.js'

/**
 * Every handler below is routed (`remote.ts`): a remote workspace's calls go to its server, a
 * local one's run here. With no remote workspace the router is a pass-through.
 */
const ipcMain = routedIpcMain(electronIpcMain)

/**
 * What the services broadcast passes through the router, which drops the local board's events
 * while a remote board is active and merges the switcher's rollup with the servers'.
 */
function broadcast(channel: string, payload?: unknown): void {
  remoteRouter.fromLocal(channel, payload)
}

/**
 * The tasks and workspaces services, wired to main's index, watchers and the other services.
 * Created before the agents service below, which takes their functions as ports.
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
    deleteTask: (taskId) => {
      deleteTask(taskId)
      reviewService.forget(taskId)
    },
    removeWorktree: (task) => gitService.checkout(task).removeWorktree(),
    brokenTaskFiles
  },
  settings: () => loadSettings(),
  requestLanding: () => requestLanding(),
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

/** A switch from outside the renderer (the tray): routed, so a remote workspace's server follows. */
export function switchWorkspace(id: string): void {
  const result = remoteRouter.invoke('workspaces:switch', [id], () => workspacesService.switch(id))
  if (result instanceof Promise) {
    result.catch((error: unknown) => console.error('Styr could not switch workspace:', error))
  }
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
  prompts: {
    promptInbox: (terminalId) => agentPrompts.promptInbox(terminalId),
    promptAgent: (terminalId, text) => agentPrompts.promptAgent(terminalId, text)
  },
  ensureAgentCli,
  prepareCodex,
  planLaunch,
  // The tray shows every connected remote workspace's agents too: the router merges them in.
  updateTray: (statuses, titles) => remoteRouter.localTrayChanged(statuses, titles),
  requestAutoRun: () => dispatchService.requestAutoRun()
})

/**
 * The terminal tabs across a relaunch (`terminalTabs.ts`). A tab created or closed saves the layout;
 * quitting freezes it first (`freezeTerminalLayout`), so killing the sessions saves nothing.
 */
const terminalTabs = createTerminalTabsService({
  store: diskTabsStore,
  settings: () => loadSettings(),
  workspaceIds: () => listWorkspaces(loadSettings()).map((workspace) => workspace.id),
  terminals: {
    listSessions: () => listSessions().filter((session) => !session.host),
    currentDirectory: (id) => terminalRuntimeState(id)?.cwd,
    createShell: ({ cwd, title }) => createSession({ cwd, title, shell: loadSettings().shell })
  },
  agents: { restoreAgent: (taskId) => agentsService.restoreAgent(taskId) },
  directoryExists: existsSync,
  now: () => new Date().toISOString()
})
onTerminalCreated(() => terminalTabs.changed())
onTerminalExit(() => terminalTabs.changed())

export function freezeTerminalLayout(): void {
  terminalTabs.freeze()
}

export function agentStatuses(): AgentStatus[] {
  return agentsService.agentStatuses()
}

/** Without a workspace, the exit is the active workspace's. */
export function markAgentExited(taskId: string, workspaceId?: string): void {
  agentsService.markAgentExited(taskId, workspaceId)
}

export function notifyAgentsChanged(): void {
  agentsService.notifyAgentsChanged()
}

/** Diffs, diff stats and the git views, over the active board's checkouts. */
const gitService = createGitService({
  loadSettings: () => loadSettings(),
  index: { query: () => queryTasks(), find: (id) => findTask(id) },
  git: diskRepoGit
})

const worklogService = createWorklogService({
  query: () => queryTasks(),
  sources: diskWorklogSources,
  yieldTurn: nextTurn
})

/** Review comments on a task's diff, and Request changes to its agent. */
const reviewService = createReviewService({
  broadcast,
  store: diskReviewStore,
  findTask,
  getTask,
  activeWorkspace: () => loadSettings().activeWorkspaceId,
  pinWorkspace: inOtherWorkspace,
  updateTask,
  addNote,
  notifyTasks: notifyTasksChanged,
  diff: (taskId) => gitService.taskDiff(taskId),
  patch: (taskId, path) => gitService.filePatch(taskId, path, true),
  route: (taskId) => agentsService.reviewRoute(taskId),
  deliver: (taskId, message) => agentsService.deliverReview(taskId, message),
  now: () => new Date().toISOString(),
  warn: (message) => console.warn(message)
})

/** A landing pass after a task change; `notifyTasksChanged` never waits for its git. */
const requestLanding = landingRequests({
  settleLandedTasks: () => settleLandedTasks(),
  notifyTasks: notifyTasksChanged
})

/**
 * Fetches `origin` where In Review work waits to land, then settles what landed (`landing.ts`).
 * Event-driven only: window focus, a Dispatch run, an Auto-run pass, the palette.
 */
export const checkForMergedWork = mergedWorkCheck({
  fetchAndSettle: () => fetchAndSettle(),
  notifyTasks: notifyTasksChanged
})

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

const settingsService = createSettingsService({
  store: diskSettingsStore,
  afterSave: (folderBefore, workspaceId) =>
    workspacesService.afterSettingsSave(folderBefore, workspaceId),
  autoRunFlagChanged: () => dispatchService.autoRunFlagChanged(),
  mcpEntry: () => mcpEntry()
})

/**
 * A Save aimed at a remote workspace writes the app-level part here and the workspace's own part
 * on its server; this is the first half, followed up as a full save would be.
 */
bindGlobalSettingsSave((global) => {
  const before = loadSettings()
  saveGlobalSettings({ ...global, activeWorkspaceId: before.activeWorkspaceId })
  workspacesService.afterSettingsSave(workspaceDir(before), before.activeWorkspaceId)
  dispatchService.autoRunFlagChanged()
})

/** Reads which workspaces are remote and, with the flag on, connects to their hosts. */
export function startRemoteWorkspaces(): void {
  startRemote((id) =>
    remoteRouter.invoke('workspaces:switch', [id], () => workspacesService.switch(id))
  )
}

/**
 * Window focus is when to look for a PR merged in the browser. For a remote board the server
 * looks, against the remote repos; while it is not live there is nothing to do.
 */
export function checkMergedOnFocus(): void {
  try {
    const result = remoteRouter.invoke('tasks:checkMerged', [], () => checkForMergedWork())
    if (result instanceof Promise) result.catch(() => undefined)
  } catch {
    // The remote board is read-only right now.
  }
}

/** Quitting ends every ssh child; the servers keep running, and so do their agents. */
export function stopRemoteWorkspaces(): void {
  remoteRouter.stopAll()
}

/** Called once the window is up: after the startup grace Auto-run evaluates the board. */
export function startAutoDispatch(): void {
  dispatchService.startAutoRun()
}

/** Auto-run of the active workspace, for the tray: routed, so a remote board's server answers. */
export async function autoRunState(): Promise<AutoDispatchState> {
  return (await remoteRouter.invoke('orchestrate:autoState', [], () =>
    dispatchService.autoState()
  )) as AutoDispatchState
}

/** The tray's Start Auto-run, routed like the renderer's switch. Stopping asks in the window. */
export async function startAutoRunFromTray(): Promise<void> {
  await remoteRouter.invoke('orchestrate:autoSet', [true], () => dispatchService.autoSet(true))
}

/**
 * The tray's request for the window (`app:command`). It is held until the renderer takes it, so a
 * window that is still loading — created by the click — runs it once it has mounted, and a live
 * one runs it at once; either way exactly once.
 */
let pendingCommand: TrayCommand | null = null

export function sendWindowCommand(command: TrayCommand): void {
  pendingCommand = command
  broadcast('app:command')
}

export function registerIpcHandlers(): void {
  initSourceSync({
    onTasksChanged: notifyTasksChanged,
    onState: (states) => broadcast('sources:state', states)
  })
  restartSourcePolling()
  ipcMain.handle('sources:providers', () => sourceProviders())
  ipcMain.handle('sources:ghStatus', () => ghStatus())
  ipcMain.handle('sources:state', () => sourceStates())
  ipcMain.handle('sources:restTest', (_event, settings: unknown) => testRestSource(settings))
  ipcMain.handle('sources:targets', (_event, sourceId: string) =>
    listSourceTargets(String(sourceId))
  )
  ipcMain.handle('sources:sync', (_event, sourceId: string) => syncSource(String(sourceId)))
  ipcMain.handle('sources:preview', (_event, sourceId: string) => previewSource(String(sourceId)))
  ipcMain.handle('sources:apply', (_event, sourceId: string, itemIds: unknown) =>
    applySource(String(sourceId), itemIds)
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
  ipcMain.handle('git:branches', (_event, repoPath: string) => gitService.branches(repoPath))
  ipcMain.handle('git:taskDiff', (_event, taskId: unknown, repo?: unknown) =>
    gitService.taskDiff(taskId, repo)
  )
  ipcMain.handle(
    'git:filePatch',
    (_event, taskId: unknown, path: unknown, full?: unknown, repo?: unknown) =>
      gitService.filePatch(taskId, path, full, repo)
  )
  ipcMain.handle('git:diffStats', () => gitService.diffStats())
  ipcMain.handle('agents:list', () => agentStatuses())
  ipcMain.handle('worklog:load', (_event, from: unknown, to: unknown) =>
    worklogService.load(from, to)
  )
  ipcMain.handle('review:get', (_event, taskId: unknown) => reviewService.get(taskId))
  ipcMain.handle('review:save', (_event, taskId: unknown, pending: unknown) =>
    reviewService.save(taskId, pending)
  )
  ipcMain.handle('review:prepare', (_event, taskId: unknown) => reviewService.prepare(taskId))
  ipcMain.handle('review:requestChanges', (_event, taskId: unknown, summary: unknown) =>
    reviewService.requestChanges(taskId, summary)
  )

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

  ipcMain.handle('app:takeCommand', () => {
    const command = pendingCommand
    pendingCommand = null
    return command
  })

  ipcMain.handle('app:mcpCommand', (_event, provider?: 'claude' | 'codex') =>
    settingsService.mcpCommand(provider)
  )

  ipcMain.handle('orchestrate:plan', () => dispatchService.plan())
  ipcMain.handle('tasks:checkMerged', () => checkForMergedWork())

  ipcMain.handle('orchestrate:run', (_event, taskIds?: string[]) => dispatchService.run(taskIds))
  ipcMain.handle('orchestrate:autoState', () => dispatchService.autoState())
  ipcMain.handle('orchestrate:autoSet', (_event, on: unknown) => dispatchService.autoSet(on))

  ipcMain.handle('settings:get', (_event, workspaceId: unknown) => settingsService.get(workspaceId))
  ipcMain.handle('settings:save', (_event, change: unknown) => settingsService.save(change))
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

  ipcMain.handle('terminal:previewPrompt', (_event, taskId: string, templateId?: string) =>
    agentsService.previewPrompt(taskId, templateId)
  )

  ipcMain.on('terminal:write', (_event, id: string, data: string) => writeToSession(id, data))
  ipcMain.on('terminal:resize', (_event, id: string, cols: number, rows: number) =>
    resizeSession(id, cols, rows)
  )
  ipcMain.handle('terminal:kill', (_event, id: string) => {
    killSession(id)
    terminalTabs.changed()
  })
  ipcMain.on('terminal:setLayout', (_event, ids: unknown, activeId: unknown) =>
    terminalTabs.setLayout(
      z.array(z.string()).max(500).catch([]).parse(ids),
      typeof activeId === 'string' ? activeId : null
    )
  )
  ipcMain.handle('terminal:pendingLayout', () => terminalTabs.offer())
  ipcMain.handle('terminal:restoreLayout', () => terminalTabs.restore())
  ipcMain.handle('terminal:dismissLayout', () => terminalTabs.dismiss())
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
  ipcMain.handle('terminal:gitContext', (_event, path: string) => gitService.gitContext(path))
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
    if (isWebLink(url)) void shell.openExternal(url)
  })
  ipcMain.handle('terminal:listDirectories', (_event, path: string, includeFiles?: boolean) =>
    listDirectories(path, includeFiles === true)
  )
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

export { broadcast }
