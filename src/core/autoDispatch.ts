import { type OrchestrationLane, type Task, type TaskSessionRef } from './types.js'
import type { OrchestrationPlan } from './orchestrate.js'
import { laneFor } from './orchestrate.js'

/** The window the per-hour launch limit (`AutoDispatchLimits.launchesPerHour`) counts over. */
export const AUTO_LAUNCH_WINDOW_MS = 60 * 60 * 1000

/**
 * What Auto-run remembers it started, `workspace:task` → the state it started it in. A launch does
 * not always take a task out of the plan (a review leaves it In Review; a spec that stops early
 * leaves it needing a spec), so without this the same run would start again every time a slot
 * frees. Memory only: it is a guard, never a record.
 */
export type AutoMemory = ReadonlyMap<string, string>

export function memoryKey(workspaceId: string, taskId: string): string {
  return `${workspaceId}:${taskId}`
}

/** The state a launch was made in; a different one makes the task eligible again. */
export function launchSignature(task: Task): string {
  return `${laneFor(task)}|${task.status}|${task.readiness ?? ''}`
}

/**
 * Drops memory of tasks that changed state or are gone, so they may be started again later, and
 * names the ones still remembered. The plan is built without them: left in, a remembered review
 * would take its lane's only slot on every pass and starve the tasks behind it.
 */
export function pruneMemory(
  tasks: readonly Task[],
  workspaceId: string,
  memory: AutoMemory
): { memory: Map<string, string>; skip: Set<string> } {
  const prefix = `${workspaceId}:`
  const byKey = new Map(tasks.map((task) => [memoryKey(workspaceId, task.id), task]))
  const kept = new Map<string, string>()
  const skip = new Set<string>()
  for (const [key, signature] of memory) {
    if (!key.startsWith(prefix)) {
      kept.set(key, signature)
      continue
    }
    const task = byKey.get(key)
    if (task && launchSignature(task) === signature) {
      kept.set(key, signature)
      skip.add(task.id)
    }
  }
  return { memory: kept, skip }
}

export interface AutoRunInput {
  /** Built with `pruneMemory`'s skip set. */
  plan: OrchestrationPlan
  workspaceId: string
  /** The pruned memory. */
  memory: ReadonlyMap<string, string>
  /** Timestamps (ms) of earlier auto launches in this workspace. */
  history: readonly number[]
  now: number
  /** Launches allowed per rolling hour (`AutoDispatchLimits.launchesPerHour`). */
  limit: number
}

export interface AutoRunDecision {
  launch: { task: Task; lane: OrchestrationLane }[]
  memory: Map<string, string>
  /** Set when the hourly limit stopped the pass short. */
  pause?: 'limit'
}

/** Which of the plan's tasks Auto-run starts now: the hourly launch limit, then remember them. */
export function decideAutoRun(input: AutoRunInput): AutoRunDecision {
  const { plan, workspaceId, history, now, limit } = input
  const memory = new Map(input.memory)
  const recent = history.filter((at) => now - at < AUTO_LAUNCH_WINDOW_MS).length
  const budget = Math.max(0, limit - recent)
  const launch = plan.dispatch.slice(0, budget)
  for (const { task } of launch) memory.set(memoryKey(workspaceId, task.id), launchSignature(task))
  return { launch, memory, ...(plan.dispatch.length > budget ? { pause: 'limit' as const } : {}) }
}

/*
 * What Auto-run must remember across a relaunch is read back from the task files, from the marks
 * a launch leaves on `sessions:` (`dispatch`, `sentBack`) and `Settings.autoDispatchSince`. The
 * runner's own memory only covers what leaves no entry: a failed launch, a resumed chat.
 */

function startedMs(entry: TaskSessionRef): number {
  return Date.parse(entry.startedAt)
}

function after(entry: TaskSessionRef, since: string | undefined): boolean {
  return since === undefined || !(startedMs(entry) <= Date.parse(since))
}

/**
 * The reviews Auto-run started that asked for fixes, newest first, since Auto-run was switched on.
 * A bounce is a review an implementer was launched over (`sentBack`), or the task's current
 * review chat while the task is back in Backlog and nobody has picked it up yet. The first review
 * that is neither passed, and ends the run: a task that passed review starts over.
 */
export function reworkBounces(task: Task, since: string | undefined): TaskSessionRef[] {
  const bounces: TaskSessionRef[] = []
  for (const entry of [...task.sessions].reverse()) {
    if (entry.dispatch !== 'review' || !after(entry, since)) continue
    const pending = entry.id === task.agentSession?.id && task.status === 'backlog'
    if (!entry.sentBack && !pending) break
    bounces.push(entry)
  }
  return bounces
}

/** Tasks that failed review `limit` times: Auto-run leaves them out of the plan. */
export function reworkHeld(
  tasks: readonly Task[],
  since: string | undefined,
  limit: number
): Set<string> {
  return new Set(
    tasks
      .filter((task) => task.status !== 'done')
      .filter((task) => reworkBounces(task, since).length >= limit)
      .map((task) => task.id)
  )
}

/** The note (and notification) for a task that reached the cap; its start is how it is found again. */
export function reworkCappedMessage(taskId: string, limit: number): string {
  return `${taskId} failed review ${limit} times; it needs you.`
}

/**
 * The newest failed review of a held task that has not been noted yet, or nothing: the capped
 * note, dated after that review started, is the record that the person was told.
 */
export function unnotedCap(
  task: Task,
  since: string | undefined,
  limit: number
): TaskSessionRef | undefined {
  const bounces = reworkBounces(task, since)
  const [newest] = bounces
  if (!newest || bounces.length < limit) return undefined
  const prefix = reworkCappedMessage(task.id, limit)
  const noted = task.activity.some(
    (entry) =>
      entry.author === 'styr' &&
      entry.message.startsWith(prefix) &&
      !(Date.parse(entry.at) < startedMs(newest))
  )
  return noted ? undefined : newest
}

/**
 * Whether the task's current chat is one Auto-run started in the lane the task is in now: that run
 * already happened on this state (a finished review left it In Review, a spec stopped early), so it
 * is not started again until the task changes lane or another run takes over.
 */
export function guardedByHistory(task: Task): boolean {
  const pointer = task.agentSession
  const current = pointer && task.sessions.find((entry) => entry.id === pointer.id)
  return current?.dispatch === laneFor(task)
}

/** When Auto-run started the sessions recorded in the past hour, oldest first. */
export function autoLaunchTimes(tasks: readonly Task[], now: number): number[] {
  return tasks
    .flatMap((task) => task.sessions)
    .filter((entry) => entry.dispatch !== undefined)
    .map(startedMs)
    .filter((at) => now - at < AUTO_LAUNCH_WINDOW_MS)
    .sort((a, b) => a - b)
}
