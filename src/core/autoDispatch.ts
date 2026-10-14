import { AUTO_REWORK_LIMIT, type OrchestrationLane, type Task } from './types.js'
import type { OrchestrationPlan } from './orchestrate.js'
import { laneFor } from './orchestrate.js'

/** Auto launches allowed per rolling hour and workspace before Auto-run switches itself off. */
export const AUTO_LAUNCH_LIMIT = 20
export const AUTO_LAUNCH_WINDOW_MS = 60 * 60 * 1000
/** Consecutive failed launches before Auto-run switches itself off. */
export const AUTO_FAILURE_LIMIT = 3

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
}

export interface AutoRunDecision {
  launch: { task: Task; lane: OrchestrationLane }[]
  memory: Map<string, string>
  /** Set when the hourly limit stopped the pass short. */
  pause?: 'limit'
}

/** Which of the plan's tasks Auto-run starts now: the hourly launch limit, then remember them. */
export function decideAutoRun(input: AutoRunInput): AutoRunDecision {
  const { plan, workspaceId, history, now } = input
  const memory = new Map(input.memory)
  const recent = history.filter((at) => now - at < AUTO_LAUNCH_WINDOW_MS).length
  const budget = Math.max(0, AUTO_LAUNCH_LIMIT - recent)
  const launch = plan.dispatch.slice(0, budget)
  for (const { task } of launch) memory.set(memoryKey(workspaceId, task.id), launchSignature(task))
  return { launch, memory, ...(plan.dispatch.length > budget ? { pause: 'limit' as const } : {}) }
}

export { AUTO_REWORK_LIMIT }

/** `workspace:task` → how many reviews Auto-run started came back asking for fixes. Memory only. */
export type ReworkCounts = ReadonlyMap<string, number>

export interface ReworkTally {
  counts: Map<string, number>
  /** Tasks that reached the limit on this pass, to notify about once. */
  capped: Task[]
  /** Every task at or over the limit: Auto-run leaves them out of the plan. */
  held: Set<string>
}

/**
 * Counts review→Backlog bounces. A bounce is seen as `pruneMemory` would see it: a task Auto-run
 * started in the review lane is now in Backlog, so the reviewer asked for fixes. Call it with the
 * memory from before pruning. A task that reaches Done, or is gone, starts over from zero.
 */
export function tallyRework(
  tasks: readonly Task[],
  workspaceId: string,
  memory: AutoMemory,
  previous: ReworkCounts
): ReworkTally {
  const prefix = `${workspaceId}:`
  const byKey = new Map(tasks.map((task) => [memoryKey(workspaceId, task.id), task]))
  const counts = new Map<string, number>()
  for (const [key, count] of previous) {
    const task = byKey.get(key)
    if (!key.startsWith(prefix) || (task && task.status !== 'done')) counts.set(key, count)
  }
  const capped: Task[] = []
  for (const [key, signature] of memory) {
    const task = byKey.get(key)
    if (!task || !signature.startsWith('review|') || task.status !== 'backlog') continue
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    if (count === AUTO_REWORK_LIMIT) capped.push(task)
  }
  const held = new Set<string>()
  for (const [key, count] of counts) {
    const task = byKey.get(key)
    if (task && count >= AUTO_REWORK_LIMIT) held.add(task.id)
  }
  return { counts, capped, held }
}
