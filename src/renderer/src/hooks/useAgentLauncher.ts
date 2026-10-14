import { useCallback } from 'react'
import { openBlockers } from '@core/blocking.js'
import { planDraft, terminalDraft } from '@core/derivedTask.js'
import { planningPrompt, planTitle } from '@core/planning.js'
import {
  TASK_STATUS_LABELS,
  type Settings,
  type Task,
  type TaskPreset,
  type TerminalSessionInfo
} from '@core/types.js'
import type { TerminalTaskRequest } from '../components/TerminalSurface.js'
import { describeBlockers } from '../lib/blockerContext.js'
import { ipcMessage } from '../lib/ipcMessage.js'

/**
 * Everything that opens a terminal tab: shells, agent launches and resumes, review and fork chats,
 * and the tasks made from terminal output or a Quick add plan. Each new session is adopted as a tab.
 */
export function useAgentLauncher({
  settings,
  lookup,
  workspaceId,
  adopt,
  activateForTask
}: {
  settings: Settings | null
  lookup: ReadonlyMap<string, Task>
  workspaceId: string
  adopt: (session: TerminalSessionInfo) => void
  /** Focuses the task's open tab; false when it has none. */
  activateForTask: (taskId: string, workspaceId: string) => boolean
}) {
  const newShell = useCallback(
    async (cwd?: string) => {
      adopt(
        await window.api.terminal.create({
          cwd: cwd || settings?.defaultRepoPath || settings?.storageDir,
          title: 'shell'
        })
      )
    },
    [adopt, settings]
  )

  const openTerminalFor = useCallback(
    (task: Task) =>
      void window.api.terminal
        .create({ cwd: task.worktreePath || task.repoPath, title: task.id })
        .then(adopt),
    [adopt]
  )

  const askReview = useCallback(
    async (taskId: string) => adopt(await window.api.terminal.askReview(taskId)),
    [adopt]
  )

  /** Ask in a copy of a task session's chat; false when that session has no saved chat to copy. */
  const askFork = useCallback(
    async (sessionId: string, question: string): Promise<boolean> => {
      const session = await window.api.terminal.askFork(sessionId, question)
      if (!session) return false
      adopt(session)
      return true
    },
    [adopt]
  )

  const resumeSession = useCallback(
    (taskId: string, sessionId: string) =>
      void window.api.terminal.resumeSession(taskId, sessionId).then(adopt),
    [adopt]
  )

  const launchAgent = useCallback(
    async (taskId: string, templateId?: string, provider?: 'claude' | 'codex') => {
      // Warn, never refuse: the user may know a blocker is as good as done. A task that already has
      // a chat is being resumed, not started, so it never asks.
      const task = lookup.get(taskId)
      const blockers = task && !task.agentSession ? openBlockers(task, lookup) : []
      if (
        blockers.length > 0 &&
        !window.confirm(
          `${taskId} is blocked by ${describeBlockers(blockers, (blocker) => TASK_STATUS_LABELS[blocker.status])}. Start anyway?`
        )
      ) {
        return
      }
      try {
        adopt(await window.api.terminal.launchAgent(taskId, templateId, provider))
      } catch (error) {
        // A refused launch (an unsupported Codex install, a disabled provider) says what to fix.
        window.alert(ipcMessage(error))
      }
    },
    [adopt, lookup]
  )

  /** Focus the task's live tab, or resume its chat when there is none. */
  const activateTask = useCallback(
    (taskId: string) => {
      if (!activateForTask(taskId, workspaceId)) void launchAgent(taskId)
    },
    [activateForTask, launchAgent, workspaceId]
  )

  /** Output the user wants an agent to look at becomes a Backlog task that carries it. */
  const createTaskFromTerminal = useCallback(
    async (request: TerminalTaskRequest): Promise<string> => {
      if (!settings) throw new Error('Settings have not loaded yet')
      const task = await window.api.tasks.create(terminalDraft(request, settings))
      if (request.launch) await launchAgent(task.id)
      return task.id
    },
    [settings, launchAgent]
  )

  /** ⌘↵ in Quick add: an agent splits the request into tasks; the throwaway task is archived after. */
  const planTasks = useCallback(
    async (request: string, preset?: TaskPreset): Promise<void> => {
      if (!settings) throw new Error('Settings have not loaded yet')
      const task = await window.api.tasks.create(
        planDraft(
          { title: planTitle(request), description: planningPrompt(request, preset) },
          settings
        )
      )
      await launchAgent(task.id)
    },
    [settings, launchAgent]
  )

  return {
    newShell,
    openTerminalFor,
    askReview,
    askFork,
    resumeSession,
    launchAgent,
    activateTask,
    createTaskFromTerminal,
    planTasks
  }
}
