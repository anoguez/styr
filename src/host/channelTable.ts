import { z } from 'zod'
import { loadSettings } from '@core/settingsStore.js'
import { sourceProviders } from '@core/sources/index.js'
import { taskStatusSchema } from '@core/taskSchema.js'
import { listDirectories } from '@host/directories.js'
import type { createAgentCliChecks } from '@host/agentCli.js'
import type { AgentsService } from '@host/agentsService.js'
import type { DispatchService } from '@host/dispatchService.js'
import type { GitService } from '@host/gitService.js'
import type { createMcpSetupChecks } from '@host/mcpSetup.js'
import type { ReviewService } from '@host/reviewService.js'
import type { SettingsService } from '@host/settingsService.js'
import type { SourceSync } from '@host/sourceSync.js'
import type { TasksService } from '@host/tasksService.js'
import type { TerminalsService } from '@host/terminals/terminalsService.js'
import type { Usage } from '@host/usage.js'
import type { createWorklogService } from '@host/worklogService.js'
import type { WorkspacesService } from '@host/workspacesService.js'

/**
 * One channel the host answers: the same name and arguments as the IPC channel, with a zod
 * schema for the argument list checked before `run` sees it.
 */
export interface Channel {
  args: z.ZodType<unknown[]>
  run(...args: never[]): unknown
}

export type ChannelTable = Record<string, Channel>

/** The services the shared channels run over. The desktop app and `styr serve` each pass their own. */
export interface ChannelServices {
  sources: Pick<
    SourceSync,
    | 'ghStatus'
    | 'sourceStates'
    | 'testRestSource'
    | 'listSourceTargets'
    | 'syncSource'
    | 'previewSource'
    | 'applySource'
    | 'linkTask'
    | 'unlinkTask'
    | 'refreshTask'
  >
  tasksService: TasksService
  gitService: GitService
  agentsService: AgentsService
  worklogService: ReturnType<typeof createWorklogService>
  reviewService: ReviewService
  dispatchService: DispatchService
  settingsService: SettingsService
  workspacesService: WorkspacesService
  cli: Pick<ReturnType<typeof createAgentCliChecks>, 'agentCliStatus'>
  mcpSetup: Pick<ReturnType<typeof createMcpSetupChecks>, 'mcpSetupStatus'>
  usage: Pick<
    Usage,
    'claudeUsage' | 'codexUsage' | 'context' | 'conversation' | 'prompt' | 'approval'
  >
  terminals: Pick<
    TerminalsService,
    'createSession' | 'listSessions' | 'sessionBacklog' | 'terminalRuntimeState' | 'writeToSession'
  > & {
    /** The desktop saves its terminal tabs after a kill, so it passes its own. */
    killSession(id: string): void
  }
  diagnostics: { snapshot(): unknown; stop(): void }
  checkForMergedWork(): unknown
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
 * The invoke and send channels both hosts answer, under the IPC names and with their arguments:
 * `ipc.ts` registers them with `ipcMain.handle`, and `styr serve` and the desktop's network
 * listener answer them through the hub. Handlers that act on the desktop machine stay in
 * `src/main/` (`docs/architecture/host.md`). `terminal:resize` is the hub's, because the size
 * follows focus.
 */
export function createChannelTable(services: ChannelServices): {
  invoke: ChannelTable
  send: ChannelTable
} {
  const {
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
    diagnostics,
    checkForMergedWork
  } = services

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
    'tasks:answerQuestion': channel(z.tuple([str, str, str]), (id, questionId, answer) =>
      tasksService.answerQuestion(id, questionId, answer)
    ),
    'tasks:delete': channel(z.tuple([str]), (id) => tasksService.delete(id)),
    'tasks:forgetSession': channel(z.tuple([str]), (id) => tasksService.forgetSession(id)),
    'tasks:checkMerged': channel(none, () => checkForMergedWork()),

    'git:branches': channel(z.tuple([str]), (repoPath) => gitService.branches(repoPath)),
    'git:taskDiff': channel(z.tuple([z.unknown()]), (taskId) => gitService.taskDiff(taskId)),
    'git:filePatch': channel(
      z.tuple([z.unknown(), z.unknown(), z.unknown().optional()]),
      (taskId, path, full) => gitService.filePatch(taskId, path, full)
    ),
    'git:diffStats': channel(none, () => gitService.diffStats()),

    'agents:list': channel(none, () => agentsService.agentStatuses()),
    'agents:remove': channel(z.tuple([str.min(1)]), (taskId) => agentsService.remove(taskId)),
    'agents:cliStatus': channel(
      z.tuple([provider, z.string().optional(), z.string().optional()]),
      (cliProvider, command, shell) =>
        cli.agentCliStatus({ provider: cliProvider, command: command ?? '', shell: shell ?? '' })
    ),
    'agents:mcpStatus': channel(z.tuple([provider, z.boolean().optional()]), (mcpProvider, fresh) =>
      mcpSetup.mcpSetupStatus({ provider: mcpProvider, fresh: fresh === true })
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

    'diagnostics:snapshot': channel(none, () => diagnostics.snapshot()),
    'diagnostics:stop': channel(none, () => diagnostics.stop()),
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

  /** One-way channels. */
  const send: ChannelTable = {
    'terminal:write': channel(z.tuple([str, str]), (id, data) => terminals.writeToSession(id, data))
  }

  return { invoke, send }
}
