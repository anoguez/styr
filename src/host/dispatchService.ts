import { z } from 'zod'
import type { AgentStatus } from '@core/agentState.js'
import { reworkCappedMessage } from '@core/autoDispatch.js'
import { createAutoDispatch } from '@core/autoDispatchRunner.js'
import type { LaunchOptions } from '@core/launch.js'
import { planOrchestration, providerForLane, type OrchestrationPlan } from '@core/orchestrate.js'
import { loadSettings, saveWorkspaceSettings } from '@core/settingsStore.js'
import type {
  AutoDispatchPause,
  AutoDispatchState,
  OrchestrationLane,
  OrchestrationSummary,
  Settings,
  Task,
  TerminalSessionInfo
} from '@core/types.js'
import type { HostPorts } from './ports.js'

/** The settings Dispatch reads and the Auto-run flag it writes, from `core/settingsStore.ts`. */
export interface DispatchSettings {
  load(): Settings
  /** Writes a workspace's own settings file. */
  saveWorkspace(settings: Settings, workspaceId: string): void
}

export const diskDispatchSettings: DispatchSettings = {
  load: () => loadSettings(),
  saveWorkspace: (settings, workspaceId) => saveWorkspaceSettings(settings, workspaceId)
}

/** The clock Auto-run's debounce, startup grace and launch history run on, and the merged-work wait. */
export interface DispatchClock {
  now(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export const realClock: DispatchClock = {
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export interface DispatchServicePorts extends Pick<HostPorts, 'broadcast' | 'notify'> {
  settings: DispatchSettings
  /** The active board, from the index, and the note a failed launch leaves on its task. */
  tasks: {
    query(): Task[]
    addNote(id: string, author: string, message: string): unknown
  }
  /** Every live terminal session, in every workspace. */
  liveSessions(): TerminalSessionInfo[]
  agentStatuses(): AgentStatus[]
  /** Starts (or reuses) a task's agent session, as the agents service does. */
  launch(taskId: string, options: LaunchOptions): Promise<TerminalSessionInfo>
  /** Fetches and settles merged work; resolves whether or not the remote answered. */
  checkForMergedWork(): Promise<void>
  clock: DispatchClock
}

/** How long a Dispatch run or Auto-run pass waits for that check before going ahead without it. */
export const MERGED_WORK_WAIT_MS = 5_000

const PAUSE_MESSAGES: Record<AutoDispatchPause, string> = {
  limit: 'Auto-run started too many tasks in an hour and has switched itself off.',
  failures: 'Auto-run switched itself off after three launches in a row failed.'
}

/**
 * Dispatch and Auto-run: the plan the Dispatch dialog shows, a manual run of it, and the Auto-run
 * runner (`core/autoDispatchRunner.ts`) wired to the board, the agents and the `notify` port. The
 * rules stay pure in `core/orchestrate.ts` and `core/autoDispatch.ts`; this is only the wiring.
 */
export function createDispatchService(ports: DispatchServicePorts) {
  const { settings, clock } = ports

  /** The check, awaited for at most `MERGED_WORK_WAIT_MS`: a slow remote never holds up a dispatch. */
  function checkForMergedWorkBriefly(): Promise<void> {
    let timer: unknown
    const deadline = new Promise<void>((resolve) => {
      timer = clock.setTimer(resolve, MERGED_WORK_WAIT_MS)
    })
    return Promise.race([ports.checkForMergedWork(), deadline]).finally(() =>
      clock.clearTimer(timer)
    )
  }

  function buildPlan(skip?: ReadonlySet<string>): OrchestrationPlan {
    const active = settings.load().activeWorkspaceId
    const liveTaskIds = new Set(
      ports
        .liveSessions()
        .filter((session) => session.workspaceId === active)
        .map((session) => session.taskId)
        .filter(Boolean) as string[]
    )
    const agents = new Map(ports.agentStatuses().map((status) => [status.taskId, status.state]))
    return planOrchestration(settings.load(), ports.tasks.query(), { liveTaskIds, agents, skip })
  }

  /** Starts one planned task the way Dispatch does, whether a person or Auto-run asked. */
  function dispatchTask(
    task: Task,
    lane: OrchestrationLane,
    auto = false
  ): Promise<TerminalSessionInfo> {
    return ports.launch(task.id, {
      withPrompt: true,
      fresh: lane === 'review',
      provider: providerForLane(settings.load(), lane),
      ...(auto ? { dispatchLane: lane } : {})
    })
  }

  /**
   * The flag is a workspace setting, so it is written to the active workspace's own file. Switching
   * it on stamps `autoDispatchSince`, which releases the tasks held after failed reviews.
   */
  function writeAutoDispatchFlag(on: boolean): void {
    const current = settings.load()
    if (current.autoDispatch === on) return
    const since = on ? { autoDispatchSince: new Date(clock.now()).toISOString() } : {}
    settings.saveWorkspace({ ...current, autoDispatch: on, ...since }, current.activeWorkspaceId)
    ports.broadcast('settings:changed', settings.load())
  }

  const autoDispatch = createAutoDispatch({
    enabled: () => settings.load().autoDispatch,
    setEnabled: writeAutoDispatchFlag,
    workspaceId: () => settings.load().activeWorkspaceId,
    since: () => settings.load().autoDispatchSince,
    beforePass: checkForMergedWorkBriefly,
    snapshot: (skip) => ({ plan: buildPlan(skip), tasks: ports.tasks.query() }),
    launch: async (task, lane) => {
      // The renderer only learns of sessions it asked for, so tell it about this one.
      ports.broadcast('orchestrate:autoStarted', await dispatchTask(task, lane, true))
    },
    noteFailure: (task, error) => {
      const message = error instanceof Error ? error.message : String(error)
      try {
        ports.tasks.addNote(task.id, 'styr', `Auto-run could not start this task: ${message}`)
      } catch {
        // The task may have been deleted meanwhile; there is nothing to note it on.
      }
    },
    reworkCapped: (task) => {
      const message = reworkCappedMessage(task.id)
      try {
        ports.tasks.addNote(
          task.id,
          'styr',
          `${message} Auto-run no longer starts it; Dispatch now still does.`
        )
      } catch {
        // The task may have been deleted meanwhile; the notification still says so.
      }
      ports.notify('Styr', message)
    },
    paused: (reason) => ports.notify('Styr', PAUSE_MESSAGES[reason]),
    stateChanged: (state) => ports.broadcast('orchestrate:autoState', state),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })

  /** The plan without the task objects, which the renderer does not need. */
  function plan(): OrchestrationSummary {
    const built = buildPlan()
    return {
      dispatch: built.dispatch.map(({ task, lane }) => ({
        taskId: task.id,
        title: task.title,
        lane,
        provider: providerForLane(settings.load(), lane)
      })),
      occupied: built.occupied,
      capacity: built.capacity,
      eligible: built.eligible,
      optedOut: built.optedOut,
      blocked: built.blocked,
      missingWorkingDir: built.missingWorkingDir,
      idleSessions: built.idleSessions,
      reworkHeld: built.dispatch
        .map(({ task }) => task.id)
        .filter((id) => autoDispatch.held().has(id))
    }
  }

  /** Dispatch now: starts the planned tasks, or only `taskIds` among them. */
  async function run(
    taskIds?: string[]
  ): Promise<{ lane: OrchestrationLane; taskId: string; session: TerminalSessionInfo }[]> {
    const wanted = taskIds ? new Set(taskIds) : null
    // A review whose PR was merged since the dialog opened is Done now, and drops out of the plan.
    await checkForMergedWorkBriefly()
    const built = buildPlan()
    return Promise.all(
      built.dispatch
        .filter(({ task }) => !wanted || wanted.has(task.id))
        .map(async ({ task, lane }) => ({
          lane,
          taskId: task.id,
          session: await dispatchTask(task, lane)
        }))
    )
  }

  /** The Auto-run toggle: on starts a pass, off is Stop. */
  function autoSet(on: unknown): AutoDispatchState {
    writeAutoDispatchFlag(z.boolean().parse(on))
    autoDispatch.enabledChanged()
    return autoDispatch.state()
  }

  return {
    plan,
    run,
    autoState: (): AutoDispatchState => autoDispatch.state(),
    autoSet,
    /** Arms an Auto-run pass; a burst of requests is one pass. */
    requestAutoRun: (): void => autoDispatch.request(),
    /** Called once the window is up: after the startup grace Auto-run evaluates the board. */
    startAutoRun: (): void => autoDispatch.start(),
    /** The flag may have changed from outside the toggle (a settings save). */
    autoRunFlagChanged: (): void => autoDispatch.enabledChanged()
  }
}

export type DispatchService = ReturnType<typeof createDispatchService>
