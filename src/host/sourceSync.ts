import { z } from 'zod'
import { loadSettings } from '@core/settingsStore.js'
import {
  adapterFor,
  currentSources,
  runCommand,
  sourceTargets,
  writableSource,
  type CliStatus,
  type CommandRunner,
  type RestSourceSettings,
  type SourceAdapter,
  type SourceWriter
} from '@core/sources/index.js'
import { testRestRequest } from '@core/sources/rest.js'
import { sourceName } from '@core/sources/restSources.js'
import {
  IMPORT_LIMIT,
  fieldHashes,
  linkedTask,
  planBlockers,
  planPush,
  planSync,
  previewPlan,
  selectActions
} from '@core/sources/sync.js'
import { restSourceSettingsSchema } from '@core/taskSchema.js'
import { addNote, createTask, getTask, listTasks, updateTask } from '@core/taskStore.js'
import type {
  RemoteItem,
  RestTestResult,
  Settings,
  SourceConfig,
  SourceSyncState,
  SourceTarget,
  SyncPreview,
  Task,
  TaskDraft,
  TaskPatch
} from '@core/types.js'

/** The sources, their adapters and the task files a sync reads and writes. */
export interface SourceSyncStore {
  loadSettings(): Settings
  /** The active workspace's sources; none while the experimental flag is off (`currentSources`). */
  sources(): SourceConfig[]
  adapterFor(provider: string): SourceAdapter | undefined
  run: CommandRunner
  /** The guarded writer (`writableSource`): the only way to change anything in a source. */
  writableSource(sourceId: string, target: string): SourceWriter
  /** Tests the REST source's request as edited (`testRestRequest`). */
  testRestRequest(settings: RestSourceSettings): Promise<RestTestResult>
  tasks: {
    list(): Task[]
    get(id: string): Task | null
    create(draft: TaskDraft): unknown
    update(id: string, patch: TaskPatch): Task
    addNote(id: string, author: string, message: string): unknown
  }
  /** The poll timers. */
  setInterval(run: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export const diskSourceSyncStore: SourceSyncStore = {
  loadSettings: () => loadSettings(),
  sources: () => currentSources(),
  adapterFor,
  run: runCommand,
  writableSource: (sourceId, target) => writableSource(sourceId, target),
  testRestRequest: (settings) => testRestRequest(settings),
  tasks: {
    list: () => listTasks(),
    get: getTask,
    create: createTask,
    update: updateTask,
    addNote
  },
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
}

/** Where a sync reports: the board changed, or a source's state did. */
export interface SourceSyncHooks {
  onTasksChanged: () => void
  onState: (states: Record<string, SourceSyncState>) => void
}

function cliProblem(status: CliStatus): string | null {
  if (status.state === 'ready') return null
  if (status.state === 'missing') return 'The GitHub CLI (gh) is not installed.'
  if (status.state === 'outdated') return `gh ${status.version} is too old.`
  return 'gh is not logged in. Run `gh auth login`.'
}

export const NO_REPOSITORIES =
  'No GitHub repository found. Give a task, or the default repo path in General settings, a checkout whose remote is on GitHub.'

/**
 * External sources (experimental): pulling a source's items into the board, linking a task to an
 * item, mirroring a linked task's status back where the source allows it, and the poll timers.
 * The rules are pure in `core/sources/sync.ts`; this runs them over the store.
 */
export function createSourceSync(store: SourceSyncStore) {
  const { tasks, run } = store
  let hooks: SourceSyncHooks | null = null
  const states = new Map<string, SourceSyncState>()
  const timers = new Map<string, unknown>()
  /** The last statuses seen, so a change can be told from a refresh. Null until the first look. */
  let snapshot: Map<string, Task> | null = null
  /** Tasks whose status a sync just set, so mirroring does not push it straight back. */
  const fromSync = new Set<string>()
  /** Links already reported stale, so a poll does not repeat the note. */
  const staleReported = new Set<string>()

  function initSourceSync(next: SourceSyncHooks): void {
    hooks = next
  }

  function sourceStates(): Record<string, SourceSyncState> {
    return Object.fromEntries(states)
  }

  function setState(id: string, state: SourceSyncState): void {
    states.set(id, state)
    hooks?.onState(sourceStates())
  }

  function find(sourceId: string): { source: SourceConfig; adapter: SourceAdapter } {
    const source = store.sources().find((item) => item.id === sourceId)
    if (!source) throw new Error('That integration is not set up.')
    const adapter = store.adapterFor(source.provider)
    if (!adapter) throw new Error(`No adapter for ${source.provider}.`)
    return { source, adapter }
  }

  /** The repositories of the active workspace's tasks, as this provider sees them. */
  function targetsOf(adapter: SourceAdapter): SourceTarget[] {
    if (adapter.fixedTarget)
      return [{ target: adapter.fixedTarget, repoPath: store.loadSettings().defaultRepoPath }]
    return sourceTargets(adapter, [
      ...tasks.list().map((task) => task.repoPath ?? ''),
      store.loadSettings().defaultRepoPath
    ])
  }

  function listSourceTargets(sourceId: string): SourceTarget[] {
    const { adapter } = find(sourceId)
    return targetsOf(adapter)
  }

  function applyPlan(actions: ReturnType<typeof planSync>['actions']): void {
    for (const action of actions) {
      if (action.kind === 'create') {
        tasks.create(action.draft)
      } else if (action.kind === 'update') {
        if (action.patch.status) fromSync.add(action.taskId)
        tasks.update(action.taskId, action.patch)
        if (action.note) tasks.addNote(action.taskId, 'styr', action.note)
      } else {
        tasks.addNote(action.taskId, 'styr', action.note)
      }
    }
  }

  /** Adds the source's blocked-by relations to tasks. A relation the store refuses (a cycle) is noted, not fatal. */
  function applyBlockers(source: SourceConfig, target: string, items: RemoteItem[]): number {
    let changed = 0
    for (const update of planBlockers(tasks.list(), items, source, target)) {
      try {
        tasks.update(update.taskId, { blockedBy: update.blockedBy })
        tasks.addNote(update.taskId, 'styr', update.note)
        changed++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        tasks.addNote(
          update.taskId,
          'styr',
          `Could not copy blocked-by from the source: ${message}`
        )
      }
    }
    return changed
  }

  /**
   * `list` only returns what matches the filters (open issues by default), so a linked issue that
   * was closed meanwhile would never be seen again. Read those one by one; one the source no longer
   * knows is noted once as stale and left alone.
   */
  async function addUnlistedLinked(
    source: SourceConfig,
    adapter: SourceAdapter,
    target: string,
    items: RemoteItem[],
    /** Off for a preview, which must not write to the board. */
    report = true
  ): Promise<void> {
    const seen = new Set(items.map((item) => item.id))
    for (const task of tasks.list()) {
      const ref = task.externalRef
      if (!ref || ref.sourceId !== source.id || ref.target !== target || seen.has(ref.id)) continue
      if (task.archivedAt) continue
      const key = `${task.id}:${ref.id}`
      try {
        items.push(await adapter.get(source, run, target, ref.id))
        staleReported.delete(key)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/not found|could not resolve|404|deleted|transferred/i.test(message)) continue
        if (!report || staleReported.has(key)) continue
        staleReported.add(key)
        tasks.addNote(
          task.id,
          'styr',
          `${target}#${ref.id} can no longer be found in the source; the link may be stale.`
        )
      }
    }
  }

  /**
   * A push that failed leaves no queue, so the next sync re-derives it from the two states: a Done
   * task whose issue is still open is closed again. Goes through the guard like any push.
   */
  async function retryPushes(
    source: SourceConfig,
    target: string,
    items: RemoteItem[]
  ): Promise<void> {
    if (!source.mirrorStatus || source.access !== 'read_write' || !source.enabled) return
    for (const item of items) {
      if (item.state !== 'open') continue
      const task = linkedTask(tasks.list(), source.id, target, item.id)
      if (!task || task.status !== 'done') continue
      try {
        await store.writableSource(source.id, target).close(item.id)
        tasks.addNote(task.id, 'styr', `Closed ${target}#${item.id} on ${sourceName(source)}.`)
      } catch {
        // noted when it first failed; tried again at the next sync
      }
    }
    hooks?.onTasksChanged()
  }

  function planFor(
    source: SourceConfig,
    adapter: SourceAdapter,
    where: SourceTarget,
    items: RemoteItem[]
  ): ReturnType<typeof planSync> {
    const { taskDefaults } = store.loadSettings()
    return planSync(tasks.list(), items, source, adapter.tagPrefix, where, {
      useWorktree: taskDefaults.useWorktree,
      orchestrate: taskDefaults.orchestrate
    })
  }

  /**
   * What a sync of the source would do, without doing it: reads the source and writes nothing, so
   * the user can pick what to apply. Never throws.
   */
  async function previewSource(sourceId: string): Promise<SyncPreview> {
    try {
      const { source, adapter } = find(sourceId)
      const problem = cliProblem(await adapter.status(run))
      if (problem) throw new Error(problem)
      const targets = targetsOf(adapter)
      if (targets.length === 0) throw new Error(NO_REPOSITORIES)
      const entries: SyncPreview['entries'] = []
      for (const where of targets) {
        const items = await adapter.list(source, run, where.target, { limit: IMPORT_LIMIT })
        await addUnlistedLinked(source, adapter, where.target, items, false)
        entries.push(...previewPlan(planFor(source, adapter, where, items), tasks.list()))
      }
      return { entries }
    } catch (error) {
      return { entries: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Pulls one source into the board. Never throws; the outcome is the source's state. With
   * `selected` (a reviewed sync) only those items' changes apply; see `selectActions`.
   */
  async function syncSource(sourceId: string, selected?: string[]): Promise<SourceSyncState> {
    const previous = states.get(sourceId)
    if (previous?.syncing) return previous
    setState(sourceId, { ...(previous ?? { created: 0, updated: 0 }), syncing: true })
    let result: SourceSyncState
    try {
      const { source, adapter } = find(sourceId)
      const status = await adapter.status(run)
      const problem = cliProblem(status)
      if (problem) throw new Error(problem)
      const targets = targetsOf(adapter)
      if (targets.length === 0) throw new Error(NO_REPOSITORIES)
      let created = 0
      let updated = 0
      const failures: string[] = []
      for (const where of targets) {
        try {
          const items = await adapter.list(source, run, where.target, { limit: IMPORT_LIMIT })
          await addUnlistedLinked(source, adapter, where.target, items)
          const planned = planFor(source, adapter, where, items)
          const plan = selected ? selectActions(planned, tasks.list(), selected) : planned
          applyPlan(plan.actions)
          const blocked = applyBlockers(source, where.target, items)
          created += plan.created
          updated += plan.updated
          void retryPushes(source, where.target, items)
          if (plan.actions.length > 0 || blocked > 0) hooks?.onTasksChanged()
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }
      result = {
        syncing: false,
        lastAt: new Date().toISOString(),
        ...(failures.length > 0 ? { error: failures.join(' ') } : {}),
        created,
        updated
      }
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

  /** A reviewed sync: applies only the items the user ticked in the preview. */
  function applySource(sourceId: string, itemIds: unknown): Promise<SourceSyncState> {
    return syncSource(sourceId, z.array(z.string()).parse(itemIds))
  }

  /**
   * Links a task to an item without importing it; reads the source but never writes to it. A bare
   * `#12` means the repository of the task's own checkout; a pasted URL names its own.
   */
  async function linkTask(taskId: string, text: string, sourceId = 'github'): Promise<Task> {
    const { source, adapter } = find(sourceId)
    if (!source.enabled) throw new Error('Turn the integration on in Settings first.')
    const task = tasks.get(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    const own = adapter.fixedTarget ?? (task.repoPath ? adapter.detectTarget(task.repoPath) : null)
    const ref = adapter.parseRef(text, own)
    if (!ref) {
      throw new Error(
        own
          ? `Not an issue of ${own}: ${text}`
          : 'Paste the issue URL; this task has no checkout on GitHub to read #numbers from.'
      )
    }
    const duplicate = tasks
      .list()
      .find(
        (other) =>
          other.id !== taskId &&
          other.externalRef?.sourceId === source.id &&
          other.externalRef.target === ref.target &&
          other.externalRef.id === ref.id
      )
    if (duplicate) throw new Error(`${ref.target}#${ref.id} is already linked to ${duplicate.id}.`)
    const item = await adapter.get(source, run, ref.target, ref.id)
    const updated = tasks.update(taskId, {
      externalRef: {
        provider: source.provider,
        id: item.id,
        url: item.url,
        sourceId: source.id,
        target: ref.target,
        remoteUpdatedAt: item.updatedAt,
        ...fieldHashes(task.title, task.description)
      }
    })
    hooks?.onTasksChanged()
    return updated
  }

  function unlinkTask(taskId: string): Task {
    const updated = tasks.update(taskId, { externalRef: undefined })
    hooks?.onTasksChanged()
    return updated
  }

  /** Re-reads one linked task's item now, whatever the poll says. */
  async function refreshTask(taskId: string): Promise<Task> {
    const task = tasks.get(taskId)
    const ref = task?.externalRef
    if (!task || !ref?.sourceId || !ref.target)
      throw new Error('This task is not linked to a source.')
    const { source, adapter } = find(ref.sourceId)
    const item = await adapter.get(source, run, ref.target, ref.id)
    const repoPath = task.repoPath ?? ''
    applyPlan(
      planSync([task], [item], source, adapter.tagPrefix, { target: ref.target, repoPath }).actions
    )
    hooks?.onTasksChanged()
    return tasks.get(taskId) ?? task
  }

  /**
   * Called after every refresh with the board as it now stands. A linked task whose status moved
   * is pushed to its source, if that source allows it; the first call only records a baseline.
   * Failures are noted on the task and never block the local change.
   */
  function observeTasks(board: Task[]): void {
    const before = snapshot
    snapshot = new Map(board.map((task) => [task.id, task]))
    if (!before) return
    const sources = store.sources()
    for (const task of board) {
      const prev = before.get(task.id)
      if (!prev || prev.status === task.status || !task.externalRef?.sourceId) continue
      if (fromSync.delete(task.id)) continue
      const source = sources.find((item) => item.id === task.externalRef?.sourceId)
      const target = task.externalRef.target
      if (!source || !target || source.access !== 'read_write' || !source.enabled) continue
      const actions = planPush(prev, task, source)
      if (actions.length === 0) continue
      void push(task.id, source.id, target, actions)
    }
  }

  async function push(
    taskId: string,
    sourceId: string,
    target: string,
    actions: ReturnType<typeof planPush>
  ): Promise<void> {
    for (const action of actions) {
      try {
        // looked up again here, so a source switched to read-only meanwhile refuses
        const writer = store.writableSource(sourceId, target)
        if (action.kind === 'close') await writer.close(action.itemId)
        else if (action.kind === 'reopen') await writer.reopen(action.itemId)
        else await writer.comment(action.itemId, action.body)
        tasks.addNote(taskId, 'styr', action.note)
      } catch (error) {
        tasks.addNote(
          taskId,
          'styr',
          `Could not update the source: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    hooks?.onTasksChanged()
  }

  /** Forgets the board baseline, e.g. after switching workspace, so the new board is not "changed". */
  function resetSourceObserver(): void {
    snapshot = null
    fromSync.clear()
  }

  /** (Re)starts one poll timer per enabled source of the active workspace. */
  function restartSourcePolling(): void {
    stopSourcePolling()
    for (const source of store.sources()) {
      if (!source.enabled || source.pollMinutes <= 0) continue
      // a reviewed source applies only what the user picked, so it never syncs on its own
      if (store.adapterFor(source.provider)?.reviewImports) continue
      timers.set(
        source.id,
        store.setInterval(() => void syncSource(source.id), source.pollMinutes * 60_000)
      )
    }
  }

  function stopSourcePolling(): void {
    for (const timer of timers.values()) store.clearInterval(timer)
    timers.clear()
  }

  /**
   * Sends the REST source's request as edited, unsaved. External sources are experimental, so only
   * with the flag on.
   */
  function testRestSource(settings: unknown): Promise<RestTestResult> {
    if (!store.loadSettings().experimental.externalSources)
      throw new Error('Turn on External sources in Settings → Experimental first.')
    return store.testRestRequest(restSourceSettingsSchema.parse(settings))
  }

  /** Whether the GitHub CLI is installed and logged in. */
  function ghStatus(): Promise<CliStatus> {
    return store.adapterFor('github')!.status(run)
  }

  return {
    initSourceSync,
    sourceStates,
    targetsOf,
    listSourceTargets,
    previewSource,
    syncSource,
    applySource,
    linkTask,
    unlinkTask,
    refreshTask,
    observeTasks,
    resetSourceObserver,
    restartSourcePolling,
    stopSourcePolling,
    testRestSource,
    ghStatus
  }
}

export type SourceSync = ReturnType<typeof createSourceSync>
