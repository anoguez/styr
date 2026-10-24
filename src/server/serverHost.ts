import { z } from 'zod'
import { pathsInWorkspace, pinWorkspace, pinnedWorkspaceId, workspaceDir } from '@core/config.js'
import { readAllAgentStatuses } from '@core/agentStore.js'
import { planLaunch } from '@core/launch.js'
import { codexTranscript } from '@core/providers/codex.js'
import { migrateLegacySettings } from '@core/settingsMigration.js'
import { loadSettings, saveGlobalSettings, tasksDir } from '@core/settingsStore.js'
import { sourceProviders } from '@core/sources/index.js'
import { taskStatusSchema } from '@core/taskSchema.js'
import { listWorkspaces } from '@core/workspaces.js'
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
import type { AgentStatus } from '@core/agentState.js'
import { globalSettingsFor, type TerminalOutput } from '@core/types.js'
import { diskWorklogSources } from '@core/worklogSources.js'
import { createAgentCliChecks, execFileShell } from '@host/agentCli.js'
import { createAgentsService, diskAgentStore, diskGit } from '@host/agentsService.js'
import { CodexMonitor, prepareCodex } from '@host/codexMonitor.js'
import { createDiagnostics } from '@host/diagnostics.js'
import { listDirectories } from '@host/directories.js'
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
import type { Channel, ChannelTable, ServerExperimental } from './hub.js'
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

const str = z.string()
const none = z.tuple([])
const provider = z.enum(['claude', 'codex'])

const spawnOptionsSchema = z.object({
  cwd: z.string().optional(),
  shell: z.string().optional(),
  title: z.string().optional(),
  taskId: z.string().optional(),
  workspaceId: z.string().optional(),
  provider: provider.optional(),
  replay: z.boolean().optional(),
  command: z.string().optional(),
  env: z.record(z.string(), z.string()).optional()
})

function channel<S extends z.ZodType<unknown[]>>(
  args: S,
  run: (...args: z.output<S>) => unknown
): Channel {
  return { args, run: run as Channel['run'] }
}

/**
 * The host services for the workspaces in this server's `storageDir`, wired as `src/main/ipc.ts`
 * wires them for the desktop app, over Node ports instead of Electron's. The tray becomes a
 * `server:tray` event and a notification a `server:notify` event, which the client raises.
 *
 * `invoke` and `send` hold one entry per IPC channel the server answers, under the same name and
 * with the same arguments; `serverHost.test.ts` holds them to `ipc.ts` so the two cannot drift.
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

  const invoke: ChannelTable = {
    'sources:providers': channel(none, () => sourceProviders()),
    'sources:ghStatus': channel(none, () => sources.ghStatus()),
    'sources:state': channel(none, () => sources.sourceStates()),
    'sources:restTest': channel(z.tuple([z.unknown()]), (settings) =>
      sources.testRestSource(settings)
    ),
    'sources:targets': channel(z.tuple([str]), (id) => sources.listSourceTargets(id)),
    'sources:sync': channel(z.tuple([str]), (id) => sources.syncSource(id)),
    'sources:preview': channel(z.tuple([str]), (id) => sources.previewSource(id)),
    'sources:apply': channel(z.tuple([str, z.unknown()]), (id, itemIds) =>
      sources.applySource(id, itemIds)
    ),
    'sources:link': channel(z.tuple([str, str]), (taskId, text) => sources.linkTask(taskId, text)),
    'sources:unlink': channel(z.tuple([str]), (taskId) => sources.unlinkTask(taskId)),
    'sources:refresh': channel(z.tuple([str]), (taskId) => sources.refreshTask(taskId)),

    'tasks:list': channel(z.tuple([z.unknown().optional()]), (filter) => tasksService.list(filter)),
    'tasks:get': channel(z.tuple([str]), (id) => tasksService.get(id)),
    'tasks:problems': channel(none, () => tasksService.problems()),
    'tasks:removeWorktree': channel(z.tuple([str]), (id) => tasksService.removeWorktree(id)),
    'tasks:create': channel(z.tuple([z.unknown()]), (draft) => tasksService.create(draft)),
    'tasks:update': channel(z.tuple([str, z.unknown()]), (id, patch) =>
      tasksService.update(id, patch)
    ),
    'tasks:note': channel(z.tuple([str, str, str]), (id, author, message) =>
      tasksService.note(id, author, message)
    ),
    'tasks:reorder': channel(z.tuple([taskStatusSchema, z.array(str)]), (status, ids) =>
      tasksService.reorder(status, ids)
    ),
    'tasks:archive': channel(z.tuple([str, z.boolean()]), (id, archived) =>
      tasksService.archive(id, archived)
    ),
    'tasks:delete': channel(z.tuple([str]), (id) => tasksService.delete(id)),
    'tasks:forgetSession': channel(z.tuple([str]), (id) => tasksService.forgetSession(id)),
    'tasks:checkMerged': channel(none, () => checkForMergedWork()),

    'git:branches': channel(z.tuple([str]), (repoPath) => gitService.branches(repoPath)),
    'git:taskDiff': channel(z.tuple([z.unknown(), z.unknown().optional()]), (taskId, repo) =>
      gitService.taskDiff(taskId, repo)
    ),
    'git:filePatch': channel(
      z.tuple([z.unknown(), z.unknown(), z.unknown().optional(), z.unknown().optional()]),
      (taskId, path, full, repo) => gitService.filePatch(taskId, path, full, repo)
    ),
    'git:diffStats': channel(none, () => gitService.diffStats()),

    'agents:list': channel(none, () => agentsService.agentStatuses()),
    'agents:remove': channel(z.tuple([str.min(1)]), (taskId) => agentsService.remove(taskId)),
    'agents:cliStatus': channel(
      z.tuple([provider, z.string().optional(), z.string().optional()]),
      (cliProvider, command, shell) =>
        cli.agentCliStatus({ provider: cliProvider, command: command ?? '', shell: shell ?? '' })
    ),
    'worklog:load': channel(z.tuple([z.unknown(), z.unknown()]), (from, to) =>
      worklogService.load(from, to)
    ),
    'review:get': channel(z.tuple([z.unknown()]), (taskId) => reviewService.get(taskId)),
    'review:save': channel(z.tuple([z.unknown(), z.unknown()]), (taskId, pending) =>
      reviewService.save(taskId, pending)
    ),
    'review:prepare': channel(z.tuple([z.unknown()]), (taskId) => reviewService.prepare(taskId)),
    'review:requestChanges': channel(
      z.tuple([z.unknown(), z.unknown().optional()]),
      (taskId, summary) => reviewService.requestChanges(taskId, summary)
    ),

    'diagnostics:snapshot': channel(none, () =>
      diagnostics.takeSnapshot({
        terminals: terminals.listSessions().length,
        taskCount: queryTasks().length
      })
    ),
    'diagnostics:stop': channel(none, () => diagnostics.stopSampling()),
    'app:mcpCommand': channel(z.tuple([provider.optional()]), (forProvider) =>
      settingsService.mcpCommand(forProvider)
    ),

    'orchestrate:plan': channel(none, () => dispatchService.plan()),
    'orchestrate:run': channel(z.tuple([z.array(str).optional()]), (taskIds) =>
      dispatchService.run(taskIds)
    ),
    'orchestrate:autoState': channel(none, () => dispatchService.autoState()),
    'orchestrate:autoSet': channel(z.tuple([z.unknown()]), (on) => dispatchService.autoSet(on)),

    'settings:get': channel(z.tuple([z.unknown().optional()]), (workspaceId) =>
      settingsService.get(workspaceId)
    ),
    'settings:save': channel(z.tuple([z.unknown()]), (change) => settingsService.save(change)),
    'settings:brokenFiles': channel(none, () => workspacesService.brokenSettingsFiles()),

    'workspaces:list': channel(none, () => workspacesService.overview()),
    'workspaces:activity': channel(none, () => workspacesService.activity()),
    'workspaces:boardSummary': channel(none, () => workspacesService.boardSummaries()),
    'workspaces:switch': channel(z.tuple([str]), (id) => workspacesService.switch(id)),
    'workspaces:create': channel(z.tuple([str]), (name) => workspacesService.create(name)),
    'workspaces:rename': channel(z.tuple([str, str]), (id, name) =>
      workspacesService.rename(id, name)
    ),
    'workspaces:delete': channel(z.tuple([str]), (id) => workspacesService.delete(id)),

    'terminal:create': channel(z.tuple([spawnOptionsSchema]), (options) =>
      terminals.createSession({ ...options, shell: options.shell || loadSettings().shell })
    ),
    'terminal:launchAgent': channel(
      z.tuple([str, z.string().optional(), provider.optional()]),
      (taskId, templateId, agentProvider) =>
        agentsService.launch(taskId, { templateId, provider: agentProvider })
    ),
    'terminal:resumeSession': channel(z.tuple([str, str]), (taskId, sessionId) =>
      agentsService.resume(taskId, sessionId)
    ),
    'terminal:previewPrompt': channel(z.tuple([str, z.string().optional()]), (taskId, template) =>
      agentsService.previewPrompt(taskId, template)
    ),
    'terminal:kill': channel(z.tuple([str]), (id) => terminals.killSession(id)),
    'terminal:list': channel(none, () => terminals.listSessions()),
    'terminal:backlog': channel(z.tuple([str]), (id) => terminals.sessionBacklog(id)),
    'terminal:runtimeState': channel(z.tuple([str]), (id) => terminals.terminalRuntimeState(id)),
    'terminal:createPr': channel(z.tuple([str]), (taskId) =>
      agentsService.askForPullRequest(taskId)
    ),
    'terminal:askReview': channel(z.tuple([str]), (taskId) => agentsService.askReview(taskId)),
    'terminal:askFork': channel(z.tuple([str, z.string().optional()]), (sessionId, question) =>
      agentsService.askFork(sessionId, question ?? '')
    ),
    'terminal:handOff': channel(z.tuple([str, z.string().optional()]), (sessionId, output) =>
      agentsService.handOff(sessionId, output ?? '')
    ),
    'terminal:gitContext': channel(z.tuple([str]), (path) => gitService.gitContext(path)),
    'terminal:listDirectories': channel(
      z.tuple([str, z.boolean().optional()]),
      (path, includeFiles) => listDirectories(path, includeFiles ?? false)
    ),

    'usage:claude': channel(none, () => usage.claudeUsage()),
    'usage:codex': channel(z.tuple([str]), (terminalId) => usage.codexUsage(terminalId)),
    'usage:context': channel(z.tuple([str]), (terminalId) => usage.context(terminalId)),
    'agent:conversation': channel(z.tuple([str]), (terminalId) => usage.conversation(terminalId)),
    'agent:prompt': channel(z.tuple([str, z.unknown()]), (terminalId, text) =>
      usage.prompt(terminalId, text)
    ),
    'agent:approval': channel(z.tuple([str, str, str]), (terminalId, approvalId, optionId) =>
      usage.approval(terminalId, approvalId, optionId)
    )
  }

  /** One-way channels: `terminal:resize` is the hub's, because the size follows focus. */
  const send: ChannelTable = {
    'terminal:write': channel(z.tuple([str, str]), (id, data) => terminals.writeToSession(id, data))
  }

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
