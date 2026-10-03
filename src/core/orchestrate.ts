import type {
  OrchestrationCapacity,
  OrchestrationLane,
  Settings,
  Task,
  TaskPriority
} from './types.js'
import { ORCHESTRATION_LANES } from './types.js'
import type { AgentState } from './agentState.js'
import type { AgentProviderId } from './providers/types.js'

export interface OrchestrationPlan {
  dispatch: { task: Task; lane: OrchestrationLane }[]
  occupied: OrchestrationCapacity
  capacity: OrchestrationCapacity
  eligible: OrchestrationCapacity
  optedOut: number
  missingWorkingDir: number
  /** Dispatchable tasks held back only by a terminal tab whose agent has stopped. */
  idleSessions: number
}

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

/**
 * Which kind of work a task represents. Mirrors prompt routing — readiness outranks status — so the
 * lane a task is dispatched into always matches the template it will actually run.
 */
export function laneFor(task: Task): OrchestrationLane {
  if (task.readiness === 'needs_spec') return 'spec'
  if (task.status === 'in_review') return 'review'
  return 'implement'
}

/** Which agent CLI a lane runs on. The settings schema defaults every lane to Claude. */
export function providerForLane(
  settings: Pick<Settings, 'providerRouting'>,
  lane: OrchestrationLane
): AgentProviderId {
  return settings.providerRouting[lane]
}

/**
 * Whether a task is waiting to be picked up. Only Backlog and In Review are dispatchable: a task
 * already In Progress belongs to whoever started it, even if its session has since died, and
 * grabbing it would quietly restart work someone may be part-way through.
 */
function isDispatchable(task: Task): boolean {
  return !task.archivedAt && (task.status === 'backlog' || task.status === 'in_review')
}

function byPriorityThenBoardOrder(a: Task, b: Task): number {
  return (
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    a.order - b.order ||
    a.createdAt.localeCompare(b.createdAt)
  )
}

function emptyTally(): OrchestrationCapacity {
  return { spec: 0, implement: 0, review: 0 }
}

export interface OrchestrationContext {
  /** Tasks with an open terminal tab. They cannot be dispatched — a launch would just focus it. */
  liveTaskIds: ReadonlySet<string>
  /** Current agent state per task. A slot is held by real activity, not by an open tab. */
  agents: ReadonlyMap<string, AgentState>
}

const BUSY_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['working', 'waiting'])

/**
 * Decides which tasks to start now. Pure: the caller supplies the tasks, the tabs that are open and
 * the current agent states, and gets back what to launch.
 *
 * Capacity is measured by agent activity, not by open terminal tabs: a session runs a login shell
 * that outlives Claude, so a finished run leaves a tab behind that would otherwise hold its slot
 * forever. A task with no working directory is left out rather than started in the board's own
 * folder, where there is no code to work on.
 */
export function planOrchestration(
  settings: Settings,
  tasks: Task[],
  context: OrchestrationContext
): OrchestrationPlan {
  const { liveTaskIds, agents } = context
  const capacity = settings.orchestration
  const occupied = emptyTally()
  for (const task of tasks) {
    const state = agents.get(task.id)
    if (state && BUSY_STATES.has(state)) occupied[laneFor(task)] += 1
  }

  const candidates = tasks
    .filter((task) => !liveTaskIds.has(task.id))
    .filter((task) => isDispatchable(task))

  const idleSessions = tasks.filter((task) => {
    if (!liveTaskIds.has(task.id) || !isDispatchable(task)) return false
    const state = agents.get(task.id)
    return !state || !BUSY_STATES.has(state)
  }).length

  const optedOut = candidates.filter((task) => !task.orchestrate).length
  const withFlag = candidates.filter((task) => task.orchestrate)
  const hasWorkingDir = (task: Task): boolean => Boolean(task.repoPath || settings.defaultRepoPath)
  const missingWorkingDir = withFlag.filter((task) => !hasWorkingDir(task)).length
  const runnable = withFlag.filter(hasWorkingDir)

  const eligible = emptyTally()
  for (const task of runnable) eligible[laneFor(task)] += 1

  const remaining = { ...capacity }
  for (const lane of ORCHESTRATION_LANES) remaining[lane] -= occupied[lane]

  const dispatch: OrchestrationPlan['dispatch'] = []
  for (const task of [...runnable].sort(byPriorityThenBoardOrder)) {
    const lane = laneFor(task)
    if (remaining[lane] <= 0) continue
    remaining[lane] -= 1
    dispatch.push({ task, lane })
  }

  return { dispatch, occupied, capacity, eligible, optedOut, missingWorkingDir, idleSessions }
}
