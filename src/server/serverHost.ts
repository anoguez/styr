import { pathsInWorkspace, pinWorkspace, pinnedWorkspaceId, workspaceDir } from '@core/config.js'
import { readAllAgentStatuses } from '@core/agentStore.js'
import { planLaunch } from '@core/launch.js'
import { codexTranscript } from '@core/providers/codex.js'
import { migrateLegacySettings } from '@core/settingsMigration.js'
import { loadSettings, saveGlobalSettings, tasksDir } from '@core/settingsStore.js'
import { listWorkspaces } from '@core/workspaces.js'
import {
  addNote,
  brokenTaskFiles,
  createTask,
  deleteTask,
  getTask,
  reorderTasks,
  setArchived,
  answerQuestion,
  updateTask
} from '@core/taskStore.js'
import type { AgentStatus } from '@core/agentState.js'
import { globalSettingsFor, type TerminalOutput } from '@core/types.js'
import { diskWorklogSources } from '@core/worklogSources.js'
import { createAgentCliChecks, execFileShell } from '@host/agentCli.js'
import { createMcpSetupChecks } from '@host/mcpSetup.js'
import { createAgentsService, diskAgentStore, diskGit } from '@host/agentsService.js'
import { CodexMonitor, prepareCodex } from '@host/codexMonitor.js'
import { createDiagnostics } from '@host/diagnostics.js'
import { createDispatchService, diskDispatchSettings, realClock } from '@host/dispatchService.js'
import { createGitService, diskRepoGit, nextTurn } from '@host/gitService.js'
import { createLanding, diskLandingStore, landingRequests, mergedWorkCheck } from '@host/landing.js'
import type { HostPorts } from '@host/ports.js'
import { createSettingsService, diskSettingsStore } from '@host/settingsService.js'
import { createSourceSync, diskSourceSyncStore } from '@host/sourceSync.js'
import { closeIndex, findTask, queryTasks, syncIndex } from '@host/taskIndex.js'
import { createTasksService } from '@host/tasksService.js'
import {
  createTerminalsService,
  terminalBroadcasts,
  type TerminalsPorts
} from '@host/terminals/terminalsService.js'
import { createUsage, watchFiles } from '@host/usage.js'
import { startWatching, startWatchingAgents, stopWatching } from '@host/watcher.js'
import { createWorklogService } from '@host/worklogService.js'
import { createReviewService, diskReviewStore } from '@host/reviewService.js'
import {
  createWorkspacesService,
  diskWorkspaceStore,
  inOtherWorkspace
} from '@host/workspacesService.js'
import { createChannelTable } from '@host/channelTable.js'
import type { ServerExperimental } from './hub.js'
import { exitOrphanedAgents } from './orphans.js'

export interface ServerHostPorts extends HostPorts {
  /** `terminal:data`, which goes only to the clients attached to that terminal. */
  terminalData(id: string, output: TerminalOutput): void
  /** A terminal exited, after its `terminal:exit` broadcast. */
  terminalExited(id: string): void
  /** The PTY (`nodePty.ts`, loaded only by the server's entry). */
  spawn: TerminalsPorts['spawn']
  /** Where this install's MCP server entry is (`out/server/mcp/index.mjs`). */
  mcpEntry(): string
  /** The server process's own cost, for the Performance panel. */
  processMetrics: Parameters<typeof createDiagnostics>[0]['processMetrics']
}

/**
 * The host services for the workspaces in this server's `storageDir`, wired as `src/main/ipc.ts`
 * wires them for the desktop app, over Node ports instead of Electron's. The tray becomes a
 * `server:tray` event and a notification a `server:notify` event, which the client raises.
 *
 * `invoke` and `send` are the shared channel table (`src/host/channelTable.ts`), which `ipc.ts`
 * registers too, so the two cannot drift.
 * The services are module singletons underneath (the index, the watchers), so a process hosts one.
 */
export function createServerHost(ports: ServerHostPorts) {
  const { broadcast } = ports

  const terminals = createTerminalsService({
    spawn: ports.spawn,
    usageEnv: (existing, terminalId) => usage.usageEnv(existing, terminalId)
  })

  const usage = createUsage({
    broadcast,
    appPaths: ports.appPaths,
    sessionTask: (terminalId) => terminals.sessionTask(terminalId),
    findTask,
    codexTranscript,
    watch: watchFiles
  })

  const diagnostics = createDiagnostics({
    appPaths: ports.appPaths,
    processMetrics: ports.processMetrics
  })

  const landing = createLanding({
    ...diskLandingStore,
    query: () => queryTasks(),
    find: (id) => findTask(id)
  })
  const requestLanding = landingRequests({
    settleLandedTasks: () => landing.settleLandedTasks(),
    notifyTasks: () => notifyTasksChanged()
  })
  const sources = createSourceSync(diskSourceSyncStore)
  const cli = createAgentCliChecks(execFileShell)
  const mcpSetup = createMcpSetupChecks(execFileShell, ports.mcpEntry, () => loadSettings())

  const tasksService = createTasksService({
    broadcast,
    index: { sync: syncIndex, query: queryTasks, find: findTask },
    store: {
      createTask,
      updateTask,
      addNote,
      reorderTasks,
      setArchived,
      answerQuestion,
      deleteTask: (taskId) => {
        deleteTask(taskId)
        reviewService.forget(taskId)
      },
      removeWorktree: (task) => gitService.checkout(task).removeWorktree(),
      brokenTaskFiles
    },
    settings: () => loadSettings(),
    requestLanding: () => requestLanding(),
    route: (taskId) => agentsService.reviewRoute(taskId),
    deliver: (taskId, message) => agentsService.deliverReview(taskId, message),
    observeTasks: sources.observeTasks,
    recordNotifyDuration: diagnostics.recordNotifyDuration,
    requestAutoRun: () => dispatchService.requestAutoRun(),
    notifyAgents: () => notifyAgentsChanged()
  })

  const notifyTasksChanged = (): void => tasksService.notifyTasksChanged()
  const notifyAgentsChanged = (): void => agentsService.notifyAgentsChanged()

  const workspacesService = createWorkspacesService({
    broadcast,
    trashItem: ports.trashItem,
    store: diskWorkspaceStore,
    activeTasks: () => queryTasks(),
    liveSessions: () => terminals.listSessions(),
    activity: () => agentsService.activity(),
    resetSources: sources.resetSourceObserver,
    restartSourcePolling: sources.restartSourcePolling,
    closeIndex,
    startTaskWatcher: () => startWatching(notifyTasksChanged),
    startAgentWatcher: () => startWatchingAgents(notifyAgentsChanged),
    notifyTasks: notifyTasksChanged,
    notifyAgents: notifyAgentsChanged
  })

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
      createSession: terminals.createSession,
      findSessionByTask: terminals.findSessionByTask,
      listSessions: terminals.listSessions,
      killSession: terminals.killSession,
      writeToSession: terminals.writeToSession,
      runtimeState: terminals.terminalRuntimeState
    },
    createMonitor: (onUpdate, onConversation) => new CodexMonitor(onUpdate, onConversation),
    publishConversation: usage.publishAgentConversation,
    prompts: {
      promptInbox: (terminalId) => usage.conversation(terminalId)?.promptInbox === true,
      promptAgent: (terminalId, text) => usage.prompt(terminalId, text)
    },
    ensureAgentCli: cli.ensureAgentCli,
    prepareCodex,
    planLaunch,
    updateTray: (statuses: AgentStatus[], titles: Map<string, string>) =>
      broadcast('server:tray', { statuses, titles: Object.fromEntries(titles) }),
    requestAutoRun: () => dispatchService.requestAutoRun()
  })

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

  const checkForMergedWork = mergedWorkCheck({
    fetchAndSettle: () => landing.fetchAndSettle(),
    notifyTasks: notifyTasksChanged
  })

  const dispatchService = createDispatchService({
    broadcast,
    notify: ports.notify,
    settings: diskDispatchSettings,
    tasks: { query: () => queryTasks(), addNote },
    liveSessions: () => terminals.listSessions(),
    agentStatuses: () => agentsService.agentStatuses(),
    launch: agentsService.launch,
    checkForMergedWork,
    clock: realClock
  })

  const settingsService = createSettingsService({
    store: diskSettingsStore,
    afterSave: (folderBefore, workspaceId) =>
      workspacesService.afterSettingsSave(folderBefore, workspaceId),
    autoRunFlagChanged: () => dispatchService.autoRunFlagChanged(),
    mcpEntry: ports.mcpEntry
  })

  const { invoke, send } = createChannelTable({
    sources,
    tasksService,
    gitService,
    agentsService,
    worklogService,
    reviewService,
    dispatchService,
    settingsService,
    workspacesService,
    cli,
    mcpSetup,
    usage,
    terminals,
    diagnostics: {
      snapshot: () =>
        diagnostics.takeSnapshot({
          terminals: terminals.listSessions().length,
          taskCount: queryTasks().length
        }),
      stop: () => diagnostics.stopSampling()
    },
    checkForMergedWork
  })

  /** What `src/main/index.ts` does once the app is ready, minus the window, tray and updater. */
  function start(): void {
    try {
      migrateLegacySettings()
    } catch (error) {
      console.error('Styr server could not move settings into the workspace folders:', error)
    }
    tasksDir()
    syncIndex()
    sources.initSourceSync({
      onTasksChanged: notifyTasksChanged,
      onState: (states) => broadcast('sources:state', states)
    })
    sources.restartSourcePolling()
    dispatchService.startAutoRun()

    const events = terminalBroadcasts(broadcast)
    terminals.onTerminalData(ports.terminalData)
    terminals.onTerminalRuntimeState(events.runtimeState)
    terminals.onTerminalExit((id, exitCode) => {
      usage.forgetContext(id)
      const task = terminals.sessionTask(id)
      events.exit(id, exitCode)
      ports.terminalExited(id)
      // The exit's timestamp and the comparisons behind it are made here, on the server's clock.
      if (task) agentsService.markAgentExited(task.taskId, task.workspaceId)
    })

    // Nothing runs yet: an agent still `working` was left by a server that died (a reboot).
    const settings = loadSettings()
    exitOrphanedAgents({
      workspaceIds: () => listWorkspaces(settings).map((workspace) => workspace.id),
      statuses: (id) => readAllAgentStatuses(pathsInWorkspace(settings, id)),
      markExited: (taskId, workspaceId) => agentsService.markAgentExited(taskId, workspaceId)
    })

    startWatching(notifyTasksChanged)
    startWatchingAgents(notifyAgentsChanged)
    notifyAgentsChanged()
    usage.start()
  }

  /**
   * `server:experimental`: the client's own flags for the features the server acts on. They are
   * app-level settings, which never sync, but the server's sources follow the desktop's switch
   * (External sources), so the last client to connect or change it sets it here.
   */
  function setExperimental(flags: ServerExperimental): void {
    const before = loadSettings()
    if (before.experimental.externalSources === flags.externalSources) return
    saveGlobalSettings({
      ...globalSettingsFor(before),
      experimental: { ...before.experimental, externalSources: flags.externalSources }
    })
    // Polling starts or stops, and every client's board re-reads its settings.
    workspacesService.afterSettingsSave(workspaceDir(before), before.activeWorkspaceId)
  }

  async function stop(): Promise<void> {
    terminals.killAllSessions()
    sources.stopSourcePolling()
    await stopWatching()
    closeIndex()
  }

  return {
    invoke,
    send,
    start,
    stop,
    terminals,
    notifyTasksChanged,
    setExperimental,
    /** The pin check the hub runs after every handler. */
    pin: { current: pinnedWorkspaceId, clear: () => pinWorkspace(undefined) }
  }
}

export type ServerHost = ReturnType<typeof createServerHost>
