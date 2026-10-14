import type { AutoDispatchPause, AutoDispatchState, OrchestrationLane, Task } from './types.js'
import type { OrchestrationPlan } from './orchestrate.js'
import {
  AUTO_FAILURE_LIMIT,
  AUTO_LAUNCH_WINDOW_MS,
  decideAutoRun,
  pruneMemory,
  tallyRework
} from './autoDispatch.js'

export const AUTO_DEBOUNCE_MS = 750
export const AUTO_STARTUP_GRACE_MS = 30_000

export interface AutoDispatchPorts {
  enabled(): boolean
  setEnabled(on: boolean): void
  workspaceId(): string
  /**
   * Runs before each pass reads the board: the fetch that lets a merged PR land first. Bounded and
   * best-effort — it resolves (never rejects) whether or not the remote answered.
   */
  beforePass(): Promise<void>
  /** The active workspace's plan and tasks, read from the index and agent map. */
  snapshot(skip: ReadonlySet<string>): { plan: OrchestrationPlan; tasks: Task[] }
  launch(task: Task, lane: OrchestrationLane): Promise<void>
  /** A launch failed; the task is not retried until it changes state. */
  noteFailure(task: Task, error: unknown): void
  /** A task failed review `AUTO_REWORK_LIMIT` times; Auto-run no longer starts it. */
  reworkCapped(task: Task): void
  /** Auto-run switched itself off. */
  paused(reason: AutoDispatchPause): void
  stateChanged(state: AutoDispatchState): void
  now(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export interface AutoDispatch {
  /** Something that can change the plan happened. Cheap: only marks work and arms one timer. */
  request(): void
  /** Call once the index, watchers and Codex monitor are ready. */
  start(): void
  /** The flag was changed from outside (the toggle, a settings save). */
  enabledChanged(): void
  state(): AutoDispatchState
  /** Active-workspace tasks Auto-run holds back after too many failed reviews. */
  held(): ReadonlySet<string>
}

/**
 * Event-driven auto-run: no interval. Events mark the runner dirty; one trailing timer coalesces a
 * burst into a single pass, and a pass in flight is never overlapped (it runs once more after).
 * Stopping is the flag going off: the flag is read before every launch, so a pass already under
 * way starts nothing further, while agents that are running are not touched.
 */
export function createAutoDispatch(ports: AutoDispatchPorts): AutoDispatch {
  let memory: ReadonlyMap<string, string> = new Map()
  const history = new Map<string, number[]>()
  let rework: ReadonlyMap<string, number> = new Map()
  let held: ReadonlySet<string> = new Set()
  let heldIn = ''
  let failures = 0
  let timer: unknown
  let running = false
  let dirty = false
  let graceUntil = 0
  /** Per workspace: switching away from a paused board must not carry its banner along. */
  let paused: { reason: AutoDispatchPause; workspaceId: string } | undefined
  let lastEmitted = ''

  function state(): AutoDispatchState {
    const reason = paused && paused.workspaceId === ports.workspaceId() ? paused.reason : undefined
    return { on: ports.enabled(), ...(reason ? { paused: reason } : {}) }
  }

  function emit(): void {
    const next = state()
    const key = JSON.stringify(next)
    if (key === lastEmitted) return
    lastEmitted = key
    ports.stateChanged(next)
  }

  function cancelPending(): void {
    if (timer !== undefined) ports.clearTimer(timer)
    timer = undefined
    dirty = false
  }

  function stopBecause(reason: AutoDispatchPause): void {
    paused = { reason, workspaceId: ports.workspaceId() }
    ports.setEnabled(false)
    cancelPending()
    ports.paused(reason)
    emit()
  }

  function arm(ms: number): void {
    if (timer !== undefined) return
    timer = ports.setTimer(() => {
      timer = undefined
      void pass()
    }, ms)
  }

  async function pass(): Promise<void> {
    if (running) {
      dirty = true
      return
    }
    if (!ports.enabled()) return cancelPending()
    const wait = graceUntil - ports.now()
    if (wait > 0) return arm(wait)
    running = true
    dirty = false
    try {
      // A merged PR moves its task to Done here, so what it blocked is in this pass's plan.
      await ports.beforePass()
      if (!ports.enabled()) return
      const workspaceId = ports.workspaceId()
      const now = ports.now()
      // Task states are read once, so the memory is pruned against the same view the plan sees.
      const first = ports.snapshot(new Set())
      const tally = tallyRework(first.tasks, workspaceId, memory, rework)
      rework = tally.counts
      held = tally.held
      heldIn = workspaceId
      for (const task of tally.capped) ports.reworkCapped(task)
      const pruned = pruneMemory(first.tasks, workspaceId, memory)
      const skip = new Set([...pruned.skip, ...tally.held])
      const { plan } = skip.size > 0 ? ports.snapshot(skip) : first
      const past = (history.get(workspaceId) ?? []).filter((at) => now - at < AUTO_LAUNCH_WINDOW_MS)
      const decision = decideAutoRun({
        plan,
        workspaceId,
        memory: pruned.memory,
        history: past,
        now
      })
      memory = decision.memory
      for (const { task, lane } of decision.launch) {
        // Read before each launch: Stop mid-pass must start nothing further.
        if (!ports.enabled() || ports.workspaceId() !== workspaceId) break
        past.push(ports.now())
        history.set(workspaceId, past)
        try {
          await ports.launch(task, lane)
          failures = 0
        } catch (error) {
          failures += 1
          ports.noteFailure(task, error)
          if (failures >= AUTO_FAILURE_LIMIT) {
            failures = 0
            return stopBecause('failures')
          }
        }
      }
      if (decision.pause && ports.enabled()) stopBecause(decision.pause)
    } finally {
      running = false
      if (dirty && ports.enabled()) arm(AUTO_DEBOUNCE_MS)
    }
  }

  function request(): void {
    if (!ports.enabled()) return
    dirty = true
    arm(AUTO_DEBOUNCE_MS)
  }

  function start(): void {
    graceUntil = ports.now() + AUTO_STARTUP_GRACE_MS
    emit()
    request()
  }

  function enabledChanged(): void {
    if (ports.enabled()) {
      paused = undefined
      failures = 0
      // Switching it on is the person saying "go": tasks held after failed reviews get another try.
      rework = new Map()
      held = new Set()
      graceUntil = 0
      request()
    } else {
      // The user's own off carries no reason.
      paused = undefined
      cancelPending()
    }
    emit()
  }

  return {
    request,
    start,
    enabledChanged,
    state,
    held: () => (heldIn === ports.workspaceId() ? held : new Set())
  }
}
