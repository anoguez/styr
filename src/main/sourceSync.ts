import { loadSettings } from '@core/settingsStore.js'
import {
  adapterFor,
  runCommand,
  writableSource,
  type CliStatus,
  type SourceAdapter
} from '@core/sources/index.js'
import { IMPORT_LIMIT, planPush, planSync, contentHash } from '@core/sources/sync.js'
import { addNote, createTask, getTask, listTasks, updateTask } from '@core/taskStore.js'
import type { SourceConfig, SourceSyncState, Task } from '@core/types.js'

interface Hooks {
  onTasksChanged: () => void
  onState: (states: Record<string, SourceSyncState>) => void
}

let hooks: Hooks | null = null
const states = new Map<string, SourceSyncState>()
const timers = new Map<string, NodeJS.Timeout>()
/** The last statuses seen, so a change can be told from a refresh. Null until the first look. */
let snapshot: Map<string, Task> | null = null
/** Tasks whose status a sync just set, so mirroring does not push it straight back. */
const fromSync = new Set<string>()

export function initSourceSync(next: Hooks): void {
  hooks = next
}

export function sourceStates(): Record<string, SourceSyncState> {
  return Object.fromEntries(states)
}

function setState(id: string, state: SourceSyncState): void {
  states.set(id, state)
  hooks?.onState(sourceStates())
}

function find(sourceId: string): { source: SourceConfig; adapter: SourceAdapter } {
  const source = loadSettings().sources.find((item) => item.id === sourceId)
  if (!source) throw new Error('That source no longer exists.')
  const adapter = adapterFor(source.provider)
  if (!adapter) throw new Error(`No adapter for ${source.provider}.`)
  return { source, adapter }
}

function cliProblem(status: CliStatus): string | null {
  if (status.state === 'ready') return null
  if (status.state === 'missing') return 'The GitHub CLI (gh) is not installed.'
  if (status.state === 'outdated') return `gh ${status.version} is too old.`
  return 'gh is not logged in. Run `gh auth login`.'
}

/** Pulls one source into the board. Never throws; the outcome is the source's state. */
export async function syncSource(sourceId: string): Promise<SourceSyncState> {
  const previous = states.get(sourceId)
  if (previous?.syncing) return previous
  setState(sourceId, { ...(previous ?? { created: 0, updated: 0 }), syncing: true })
  let result: SourceSyncState
  try {
    const { source, adapter } = find(sourceId)
    const status = await adapter.status(runCommand)
    const problem = cliProblem(status)
    if (problem) throw new Error(problem)
    const items = await adapter.list(source, runCommand, { limit: IMPORT_LIMIT })
    const plan = planSync(listTasks(), items, source, adapter.tagPrefix)
    for (const action of plan.actions) {
      if (action.kind === 'create') {
        createTask(action.draft)
      } else if (action.kind === 'update') {
        if (action.patch.status) fromSync.add(action.taskId)
        updateTask(action.taskId, action.patch)
        if (action.note) addNote(action.taskId, 'styr', action.note)
      } else {
        addNote(action.taskId, 'styr', action.note)
      }
    }
    result = {
      syncing: false,
      lastAt: new Date().toISOString(),
      created: plan.created,
      updated: plan.updated
    }
    if (plan.actions.length > 0) hooks?.onTasksChanged()
  } catch (error) {
    result = {
      syncing: false,
      lastAt: previous?.lastAt,
      error: error instanceof Error ? error.message : String(error),
      created: 0,
      updated: 0
    }
  }
  setState(sourceId, result)
  return result
}

/** Links a task to an item without importing it; reads the source but never writes to it. */
export async function linkTask(taskId: string, sourceId: string, text: string): Promise<Task> {
  const { source, adapter } = find(sourceId)
  const id = adapter.parseRef(source, text)
  if (!id) throw new Error(`Not an item of ${source.repo}: ${text}`)
  const task = getTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)
  const duplicate = listTasks().find(
    (other) =>
      other.id !== taskId && other.externalRef?.sourceId === sourceId && other.externalRef.id === id
  )
  if (duplicate) throw new Error(`#${id} is already linked to ${duplicate.id}.`)
  const item = await adapter.get(source, runCommand, id)
  const updated = updateTask(taskId, {
    externalRef: {
      provider: source.provider,
      id: item.id,
      url: item.url,
      sourceId,
      remoteUpdatedAt: item.updatedAt,
      syncedHash: contentHash(task.title, task.description)
    }
  })
  hooks?.onTasksChanged()
  return updated
}

export function unlinkTask(taskId: string): Task {
  const updated = updateTask(taskId, { externalRef: undefined })
  hooks?.onTasksChanged()
  return updated
}

/** Re-reads one linked task's item now, whatever the poll says. */
export async function refreshTask(taskId: string): Promise<Task> {
  const task = getTask(taskId)
  const ref = task?.externalRef
  if (!task || !ref?.sourceId) throw new Error('This task is not linked to a source.')
  const { source, adapter } = find(ref.sourceId)
  const item = await adapter.get(source, runCommand, ref.id)
  const plan = planSync([task], [item], source, adapter.tagPrefix)
  for (const action of plan.actions) {
    if (action.kind !== 'update') continue
    if (action.patch.status) fromSync.add(action.taskId)
    updateTask(action.taskId, action.patch)
    if (action.note) addNote(action.taskId, 'styr', action.note)
  }
  hooks?.onTasksChanged()
  return getTask(taskId) ?? task
}

/**
 * Called after every refresh with the board as it now stands. A linked task whose status moved
 * is pushed to its source, if that source allows it; the first call only records a baseline.
 * Failures are noted on the task and never block the local change.
 */
export function observeTasks(tasks: Task[]): void {
  const before = snapshot
  snapshot = new Map(tasks.map((task) => [task.id, task]))
  if (!before) return
  const sources = loadSettings().sources
  for (const task of tasks) {
    const prev = before.get(task.id)
    if (!prev || prev.status === task.status || !task.externalRef?.sourceId) continue
    if (fromSync.delete(task.id)) continue
    const source = sources.find((item) => item.id === task.externalRef?.sourceId)
    if (!source || source.access !== 'read_write' || !source.enabled) continue
    const actions = planPush(prev, task, source)
    if (actions.length === 0) continue
    void push(task.id, source.id, actions)
  }
}

async function push(
  taskId: string,
  sourceId: string,
  actions: ReturnType<typeof planPush>
): Promise<void> {
  for (const action of actions) {
    try {
      // looked up again here, so a source switched to read-only meanwhile refuses
      const writer = writableSource(sourceId)
      if (action.kind === 'close') await writer.close(action.itemId)
      else if (action.kind === 'reopen') await writer.reopen(action.itemId)
      else await writer.comment(action.itemId, action.body)
      addNote(taskId, 'styr', action.note)
    } catch (error) {
      addNote(
        taskId,
        'styr',
        `Could not update the source: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  hooks?.onTasksChanged()
}

/** Forgets the board baseline, e.g. after switching workspace, so the new board is not "changed". */
export function resetSourceObserver(): void {
  snapshot = null
  fromSync.clear()
}

/** (Re)starts one poll timer per enabled source of the active workspace. */
export function restartSourcePolling(): void {
  for (const timer of timers.values()) clearInterval(timer)
  timers.clear()
  for (const source of loadSettings().sources) {
    if (!source.enabled || source.pollMinutes <= 0) continue
    timers.set(
      source.id,
      setInterval(() => void syncSource(source.id), source.pollMinutes * 60_000)
    )
  }
}

export function stopSourcePolling(): void {
  for (const timer of timers.values()) clearInterval(timer)
  timers.clear()
}
