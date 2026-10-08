import { askTitle, forkDescription } from './askAgent.js'
import { askDraft, handoffDraft } from './derivedTask.js'
import { agentHandoffPrompt, handoffFileName, isAgentProgram, renderHandoff } from './handoff.js'
import type { LaunchOptions, LaunchPlan } from './launch.js'
import { providerForLane } from './orchestrate.js'
import { resolveTemplateFor } from './prompt.js'
import { createPullRequestPrompt } from './pullRequest.js'
import { providerById } from './providers/index.js'
import type { ThreadUpdate } from './providers/codexProtocol.js'
import { TaskLaunchGate } from './taskLaunchGate.js'
import {
  WORKTREE_BRANCH_PREFIX,
  type Settings,
  type Task,
  type TaskDraft,
  type TaskPatch,
  type TerminalSessionInfo
} from './types.js'
import type { AgentStatus } from './agentState.js'

/**
 * The session launch lifecycle, free of Electron: everything it touches comes in through
 * `SessionPorts`, so the guards and the metadata a launch records are tested with fakes. `ipc.ts`
 * supplies the real ports and forwards its handlers here.
 */

/** How long an agent's input box gets to take typed text before Enter arrives. */
export const SUBMIT_DELAY_MS = 250

/**
 * The monitor is keyed by one string, and task ids repeat across workspaces — so it is handed
 * `<workspace>:<task>` and the pair is recovered from its updates. Workspace ids never contain a
 * colon, so the first one splits it.
 */
export function monitorKey(workspaceId: string, taskId: string): string {
  return `${workspaceId}:${taskId}`
}

export function splitMonitorKey(key: string): { workspaceId: string; taskId: string } {
  const at = key.indexOf(':')
  return { workspaceId: key.slice(0, at), taskId: key.slice(at + 1) }
}

/** What a launch hands the terminal layer; a subset of the pty manager's spawn options. */
export interface SessionRequest {
  cwd: string
  shell: string
  title: string
  taskId: string
  workspaceId: string
  provider: 'claude' | 'codex'
  command: string
  env: Record<string, string>
}

export interface RuntimeSnapshot {
  cwd?: string
  runningCommand?: { command?: string } | null
}

export interface WorkingTreeSummary {
  status: string
  diffStat: string
  commits: string
}

export interface SessionPorts {
  /** Settings of the workspace in force — honours `pinWorkspace`, like `loadSettings`. */
  settings(): Settings
  /** Index lookup in the active workspace. */
  findTask(taskId: string): Task | null | undefined
  /** File read; used while another workspace is pinned, where the index is the wrong one. */
  getTask(taskId: string): Task | null | undefined
  updateTask(taskId: string, patch: TaskPatch): unknown
  addNote(taskId: string, author: string, message: string): unknown
  createTask(draft: TaskDraft): Task
  /** Re-index and broadcast the active workspace's board. */
  notifyTasks(): void
  notifyAgents(): void
  recordAgentEvent(workspaceId: string, taskId: string, event: string): void
  /** Wraps a synchronous write with every task path resolved in `workspaceId`. */
  pinWorkspace<T>(workspaceId: string, work: () => T): T

  createSession(request: SessionRequest): TerminalSessionInfo
  findSessionByTask(taskId: string, workspaceId: string): TerminalSessionInfo | undefined
  listSessions(): TerminalSessionInfo[]
  killSession(sessionId: string): void
  writeToSession(sessionId: string, data: string): void
  runtimeState(sessionId: string): RuntimeSnapshot | undefined
  agentStatuses(): AgentStatus[]

  monitor: {
    expect(socketPath: string, key: string, cwd: string): Promise<void>
    watch(socketPath: string, key: string, threadId: string): Promise<void>
    release(key: string): void
  }
  /** Refuses (throws) when Codex cannot be monitored; otherwise gives the control socket. */
  prepareCodex(command: string): Promise<string>
  planLaunch(settings: Settings, task: Task, options: LaunchOptions): LaunchPlan

  git: {
    branch(cwd: string): string | undefined
    baseBranch(repoPath: string): string | undefined
    workingTree(cwd: string): WorkingTreeSummary
  }
  /** Writes a handoff document into the workspace folder and returns its path. */
  writeHandoff(fileName: string, content: string): string
}

/** The board changes a launch makes to its task, as data. Pure; `sessionLabel` is not the renderer's. */
export function launchPatch(
  settings: Settings,
  task: Task,
  plan: Pick<LaunchPlan, 'provider' | 'worktreePath'>,
  templateId: string | undefined,
  sessionId?: string,
  sessionLabel?: string,
  now: () => string = () => new Date().toISOString()
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
        startedAt: now(),
        label: sessionLabel ?? resolveTemplateFor(settings, task, templateId).name
      }
    ]
  }
  return patch
}

export function createSessionLifecycle(ports: SessionPorts) {
  /** The template a fresh Codex launch used, for labelling its history entry once the id arrives. */
  const pendingTemplates = new Map<string, string | undefined>()
  const gate = new TaskLaunchGate()

  /**
   * The one place a launch's metadata is written. The active workspace goes through the index and
   * notifies; another workspace is pinned and read from its files (the board shows a different one
   * now, and its index catches up when it is next opened).
   */
  function saveLaunchMetadata(
    workspaceId: string,
    taskId: string,
    plan: Pick<LaunchPlan, 'provider' | 'worktreePath' | 'warning'>,
    templateId: string | undefined,
    sessionId?: string,
    sessionLabel?: string
  ): void {
    const active = workspaceId === ports.settings().activeWorkspaceId
    const write = (task: Task): boolean => {
      const patch = launchPatch(ports.settings(), task, plan, templateId, sessionId, sessionLabel)
      const changed = Object.keys(patch).length > 0
      if (changed) ports.updateTask(task.id, patch)
      if (plan.warning) ports.addNote(task.id, 'styr', plan.warning)
      return changed || Boolean(plan.warning)
    }
    if (active) {
      const task = ports.findTask(taskId)
      if (task && write(task)) ports.notifyTasks()
      return
    }
    ports.pinWorkspace(workspaceId, () => {
      const task = ports.getTask(taskId)
      if (task) write(task)
    })
  }

  /** A Codex update from the daemon: record the event, and save the thread id once it is known. */
  function recordCodexUpdate(update: ThreadUpdate): void {
    const { workspaceId, taskId } = splitMonitorKey(update.taskId)
    ports.recordAgentEvent(workspaceId, taskId, update.event)
    if (update.boundSessionId) {
      const key = monitorKey(workspaceId, taskId)
      saveLaunchMetadata(
        workspaceId,
        taskId,
        { provider: 'codex' },
        pendingTemplates.get(key),
        update.boundSessionId
      )
      pendingTemplates.delete(key)
    }
    ports.notifyAgents()
  }

  async function start(taskId: string, options: LaunchOptions): Promise<TerminalSessionInfo> {
    const task = ports.findTask(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)

    const settings = ports.settings()
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
      requestedProvider === 'codex' ? await ports.prepareCodex(settings.codexCommand) : undefined
    // The board may have switched while Codex was being checked; everything below writes to the
    // active workspace's files, so it must still be the one this launch was planned in.
    if (ports.settings().activeWorkspaceId !== workspaceId) {
      throw new Error('The workspace changed while the agent was starting. Try again.')
    }

    const plan = ports.planLaunch(settings, task, options)
    // A fresh Codex thread is created by the TUI, so its id is only known once the daemon announces
    // it; the monitor saves it then. Every other session has its id up front.
    const awaitingThreadId = plan.provider === 'codex' && !plan.resumed
    saveLaunchMetadata(
      workspaceId,
      task.id,
      plan,
      options.templateId,
      awaitingThreadId ? undefined : plan.sessionId,
      options.sessionLabel
    )

    if (socketPath) {
      if (awaitingThreadId) {
        pendingTemplates.set(key, options.templateId)
        await ports.monitor.expect(socketPath, key, plan.cwd)
      } else await ports.monitor.watch(socketPath, key, plan.sessionId)
    }
    try {
      const session = ports.createSession({
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
        ports.recordAgentEvent(workspaceId, task.id, 'SessionStart')
        ports.notifyAgents()
      }
      return session
    } catch (error) {
      ports.monitor.release(key)
      pendingTemplates.delete(key)
      throw error
    }
  }

  /**
   * Starts (or focuses) an agent session for a task. Shared by the per-task launch and the
   * orchestrator so both advance the board and record the session the same way. Task ids repeat
   * across workspaces, so "one live session per task" is per workspace too.
   */
  function startForTask(taskId: string, options: LaunchOptions = {}): Promise<TerminalSessionInfo> {
    const workspaceId = ports.settings().activeWorkspaceId
    return gate.startOrReuse(
      monitorKey(workspaceId, taskId),
      () => ports.findSessionByTask(taskId, workspaceId),
      () => start(taskId, options)
    )
  }

  /**
   * Types a request into a running agent and submits it. The text and the Enter go in separate
   * writes: an agent CLI treats a burst that ends in a newline as a paste, and a pasted newline adds
   * a line to its input box instead of sending it, so the request would sit there unsent.
   */
  function submitToAgent(sessionId: string, text: string): void {
    ports.writeToSession(sessionId, text)
    setTimeout(() => ports.writeToSession(sessionId, '\r'), SUBMIT_DELAY_MS)
  }

  const agentState = (taskId: string): AgentStatus['state'] | undefined =>
    ports.agentStatuses().find((status) => status.taskId === taskId)?.state

  /**
   * Asks the agent running a task to open its pull request, by typing the request into its session.
   * Only a live, idle agent is asked: text typed at a bare shell would run, and a request queued
   * behind a working agent would surprise.
   */
  function askForPullRequest(taskId: string): void {
    const task = ports.findTask(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    const settings = ports.settings()
    const live = ports.findSessionByTask(taskId, settings.activeWorkspaceId)
    const running = live && ports.runtimeState(live.id)?.runningCommand
    if (!live || !running) {
      throw new Error('This task has no running agent to ask. Resume it first.')
    }
    const state = agentState(taskId)
    if (state === 'working' || state === 'waiting') {
      throw new Error('The agent is still working on this task. Ask once it stops.')
    }
    const repoPath = task.repoPath || settings.defaultRepoPath.trim()
    const base = task.baseBranch || (repoPath ? ports.git.baseBranch(repoPath) : undefined)
    submitToAgent(live.id, createPullRequestPrompt({ taskFile: task.filePath, base }))
  }

  /**
   * Starts a fresh reviewer on an In Review task — the launch Orchestrate makes for the review lane.
   * Orchestrate skips a task whose tab is open, but this is asked from that very tab, so an agent
   * that is not mid-turn gives way: its chat stays in the task's history and the reviewer starts clean.
   */
  async function askReview(taskId: string): Promise<TerminalSessionInfo> {
    const task = ports.findTask(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    if (task.status !== 'in_review') throw new Error(`${taskId} is not in review`)
    const settings = ports.settings()
    const live = ports.findSessionByTask(taskId, settings.activeWorkspaceId)
    if (live) {
      const state = agentState(taskId)
      if (state === 'working' || state === 'waiting') {
        throw new Error('The agent is still working on this task. Ask for a review once it stops.')
      }
      ports.killSession(live.id)
    }
    return startForTask(taskId, {
      withPrompt: true,
      fresh: true,
      provider: providerForLane(settings, 'review')
    })
  }

  /**
   * Ask agent from a task session: a new task whose agent continues a copy of this one's chat, in
   * the same checkout. The source session and task are left running as they were. Returns null when
   * there is nothing to fork (no saved chat); the renderer then hands the terminal text to a fresh task.
   */
  async function askFork(sessionId: string, question: string): Promise<TerminalSessionInfo | null> {
    const info = ports.listSessions().find((session) => session.id === sessionId)
    if (!info) throw new Error('That terminal session is gone')
    const settings = ports.settings()
    if (!info.taskId || info.workspaceId !== settings.activeWorkspaceId) return null
    const source = ports.findTask(info.taskId)
    const ref = source?.agentSession
    if (!source || !ref || !providerById(ref.provider).sessionExists(ref.id)) return null

    // The fork runs where the source does: Claude keys its transcripts by directory, and the
    // answer should see the same files.
    const task = ports.createTask(
      askDraft({
        title: askTitle(question, `Ask: ${source.title}`),
        description: forkDescription(question, source),
        source,
        cwd: info.cwd,
        provider: ref.provider
      })
    )
    ports.addNote(source.id, 'styr', `Forked for a question as ${task.id}`)
    ports.notifyTasks()
    try {
      return await startForTask(task.id, {
        forkFrom: ref.id,
        provider: ref.provider,
        withPrompt: true,
        sessionLabel: `Fork of ${source.id}`
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message} (the question is saved as ${task.id} in Backlog)`, {
        cause: error
      })
    }
  }

  /**
   * Writes a handoff document for a terminal session and opens a Backlog task that points at it, so
   * another agent can pick the work up. The new task is not orchestrated: handing work off should
   * not silently start an agent.
   */
  function handOff(
    sessionId: string,
    output: string
  ): { taskId: string; path: string; agentAsked: boolean } {
    const info = ports.listSessions().find((session) => session.id === sessionId)
    if (!info) throw new Error('That terminal session is gone')
    const settings = ports.settings()
    const runtime = ports.runtimeState(sessionId)
    const cwd = runtime?.cwd || info.cwd
    // Only an agent that is actually running can be asked: text typed at a bare shell would run.
    const running = runtime?.runningCommand?.command
    const agentAsked = Boolean(running && (info.taskId || isAgentProgram(running)))
    const source =
      (info.taskId && info.workspaceId === settings.activeWorkspaceId
        ? ports.findTask(info.taskId)
        : null) ?? undefined
    const branch = ports.git.branch(cwd)
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
      ...ports.git.workingTree(cwd),
      output,
      createdAt,
      awaitingAgentSummary: agentAsked
    })
    const path = ports.writeHandoff(handoffFileName(source, createdAt), document)

    // The new worktree starts from the source's branch, so the commits carry over. Uncommitted work
    // does not; the document says where it is.
    const carryBranch = branch?.startsWith(WORKTREE_BRANCH_PREFIX) ? branch : undefined
    const subject = source ? source.title : `work in ${cwd.split(/[\\/]/).pop() || cwd}`
    const task = ports.createTask(
      handoffDraft(
        {
          title: `Continue: ${subject}`,
          description: [
            source
              ? `Pick up ${source.id} where the previous agent stopped.`
              : 'Pick up the work from a terminal session where the previous agent stopped.',
            '',
            `Read the handoff document first: ${path}`
          ].join('\n'),
          source,
          baseBranch: carryBranch,
          document: path
        },
        settings
      )
    )
    if (source) {
      ports.addNote(source.id, 'styr', `Handed off as ${task.id}; handoff document: ${path}`)
    }
    // Last, so a failure above never leaves the agent writing a document nothing points at.
    if (agentAsked) submitToAgent(sessionId, agentHandoffPrompt(path))
    ports.notifyTasks()
    return { taskId: task.id, path, agentAsked }
  }

  return { startForTask, recordCodexUpdate, askForPullRequest, askReview, askFork, handOff }
}

export type SessionLifecycle = ReturnType<typeof createSessionLifecycle>
