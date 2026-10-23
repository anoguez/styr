import { taskFilterSchema } from '@core/taskSchema.js'
import { isSpecHandoff } from '@core/specHandoff.js'
import type { Settings, Task, TaskFilter } from '@core/types.js'
import type { HostPorts } from './ports.js'
import { createTaskWrites, type TaskWritePorts } from './taskWrites.js'

/**
 * The active board: its index, the re-index-and-broadcast that follows every task write, and the
 * `tasks:*` operations. Everything here is synchronous, so a write is indexed and broadcast before
 * its call returns.
 */
export interface TasksServicePorts extends Pick<HostPorts, 'broadcast'> {
  /** The derived SQLite index of the active workspace (`taskIndex.ts`). */
  index: {
    sync(): void
    query(filter?: TaskFilter): Task[]
    find(id: string): Task | null | undefined
  }
  /** The active workspace's settings, for the prompt routing the hand-off rule reads. */
  settings(): Settings
  /** The task-file operations, from `core/taskStore.ts`. */
  store: Pick<
    TaskWritePorts,
    | 'createTask'
    | 'updateTask'
    | 'addNote'
    | 'reorderTasks'
    | 'setArchived'
    | 'answerQuestion'
    | 'deleteTask'
    | 'removeWorktree'
  > & { brokenTaskFiles(): { filePath: string; reason: string }[] }
  /**
   * Asks for a landing pass (In Review work that landed moves to Done). Returns at once: the pass
   * runs git off the main thread and re-indexes itself when it writes.
   */
  requestLanding(): void
  /** Delivers an answer to the task's agent: the routes of Request changes (`agentsService`). */
  route: TaskWritePorts['route']
  deliver: TaskWritePorts['deliver']
  /** Hands the board to the external-source observer. */
  observeTasks(tasks: Task[]): void
  /** Feeds the Performance panel. */
  recordNotifyDuration(ms: number): void
  /** Arms an Auto-run pass; the runner coalesces a burst of requests into one. */
  requestAutoRun(): void
  notifyAgents(): void
}

export function createTasksService(ports: TasksServicePorts) {
  const { index, store } = ports

  /**
   * A spec run that handed the task back (Backlog + ready) stops being the task's current chat, so
   * the implement run that follows starts fresh. Only the pointer goes; `sessions` keeps the chat.
   * Derived and idempotent: once cleared nothing qualifies, so it writes nothing and cannot loop
   * with the watcher. Returns whether it wrote.
   */
  function unlinkSpecChats(): boolean {
    const candidates = index
      .query()
      .filter((task) => task.status === 'backlog' && task.agentSession !== undefined)
    if (candidates.length === 0) return false
    const settings = ports.settings()
    let wrote = false
    for (const task of candidates) {
      if (!isSpecHandoff(settings, task)) continue
      store.updateTask(task.id, { agentSession: undefined })
      wrote = true
    }
    return wrote
  }

  /**
   * Re-indexes the active board and tells the renderer. Runs on every task write and every watcher
   * event, so it stays cheap and runs no git: the index re-reads only changed files, and the
   * landing check is requested, not awaited.
   */
  function notifyTasksChanged(): void {
    const started = performance.now()
    index.sync()
    if (unlinkSpecChats()) index.sync()
    ports.observeTasks(index.query())
    ports.recordNotifyDuration(performance.now() - started)
    ports.broadcast('tasks:changed')
    ports.requestLanding()
    ports.requestAutoRun()
  }

  const writes = createTaskWrites({
    ...store,
    findTask: index.find,
    route: ports.route,
    deliver: ports.deliver,
    notifyTasks: notifyTasksChanged,
    notifyAgents: ports.notifyAgents
  })

  return {
    notifyTasksChanged,
    list: (filter: unknown): Task[] => index.query(taskFilterSchema.parse(filter ?? {})),
    get: (id: string): Task | null | undefined => index.find(id),
    problems: (): { filePath: string; reason: string }[] => store.brokenTaskFiles(),
    ...writes
  }
}

export type TasksService = ReturnType<typeof createTasksService>
