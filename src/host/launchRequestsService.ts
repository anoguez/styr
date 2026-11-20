import { indexTasks, openBlockers } from '@core/blocking.js'
import type { LaunchOptions } from '@core/launch.js'
import {
  claimLaunchRequests,
  writeLaunchResult,
  type LaunchRequest,
  type LaunchResult
} from '@core/launchRequests.js'
import { pathsInWorkspace } from '@core/config.js'
import { loadSettings } from '@core/settingsStore.js'
import { listTasks } from '@core/taskStore.js'
import type { Task, TerminalSessionInfo } from '@core/types.js'
import type { HostPorts } from './ports.js'

export interface LaunchRequestsPorts extends Pick<HostPorts, 'broadcast'> {
  /** A workspace's tasks: the index for the active one, the files for a background one. */
  tasks(workspaceId: string): Task[]
  /** Takes the pending requests in one workspace (`claimLaunchRequests`). */
  claim(workspaceId: string): LaunchRequest[]
  answer(workspaceId: string, requestId: string, result: LaunchResult): void
  /** The card's Start: `agentsService.launch`, in the request's workspace. */
  launch(taskId: string, options: LaunchOptions, workspaceId: string): Promise<TerminalSessionInfo>
}

/** The request files in each workspace's `.styr/launches/`, from `core/launchRequests.ts`. */
export const diskLaunchRequests: Pick<LaunchRequestsPorts, 'claim' | 'answer'> = {
  claim: (workspaceId) => claimLaunchRequests(pathsInWorkspace(loadSettings(), workspaceId)),
  answer: (workspaceId, requestId, result) =>
    writeLaunchResult(pathsInWorkspace(loadSettings(), workspaceId), requestId, result)
}

/**
 * A workspace's tasks for `tasks`: the index answers for the active one; a background one is read
 * from its files, pinned only for that synchronous read.
 */
export function tasksInWorkspace(
  workspaceId: string,
  activeTasks: () => Task[],
  pin: <T>(workspaceId: string, work: () => T) => T
): Task[] {
  return workspaceId === loadSettings().activeWorkspaceId
    ? activeTasks()
    : pin(workspaceId, () => listTasks())
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Answers the MCP server's `start_task`. It does what clicking Start on the card does — the same
 * launch, the same blocked warning (answered by `startAnyway` instead of a dialog) — and tells the
 * windows about the new session so its tab opens as it would after the click. A request from a
 * background workspace starts there too, and its tab opens without switching the board to it.
 */
export function createLaunchRequestsService(ports: LaunchRequestsPorts) {
  async function handle(workspaceId: string, request: LaunchRequest): Promise<LaunchResult> {
    const tasks = ports.tasks(workspaceId)
    const byId = indexTasks(tasks)
    const task = byId.get(request.taskId)
    if (!task) return { ok: false, error: `Task ${request.taskId} not found` }
    // As on the card: a task that already has a chat is resumed, not started, so it never asks.
    const blockers = task.agentSession ? [] : openBlockers(task, byId)
    if (blockers.length > 0 && !request.startAnyway) {
      const list = blockers.map((blocker) => `${blocker.id} (${blocker.status})`).join(', ')
      return {
        ok: false,
        error: `${task.id} is blocked by ${list}. Call start_task again with startAnyway: true to start it anyway.`
      }
    }
    try {
      const session = await ports.launch(
        task.id,
        { templateId: request.templateId, provider: request.provider },
        workspaceId
      )
      ports.broadcast('terminal:launched', session)
      return { ok: true, sessionId: session.id, taskId: task.id, provider: session.provider }
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  }

  /** Claims and answers every request in a workspace; called by the watcher on each change. */
  async function process(workspaceId: string): Promise<void> {
    let requests: LaunchRequest[]
    try {
      requests = ports.claim(workspaceId)
    } catch {
      return // The workspace folder went away.
    }
    for (const request of requests) {
      const result = await handle(workspaceId, request)
      try {
        ports.answer(workspaceId, request.id, result)
      } catch (error) {
        console.error('Styr could not answer a start_task request:', error)
      }
    }
  }

  return { process }
}

export type LaunchRequestsService = ReturnType<typeof createLaunchRequestsService>
