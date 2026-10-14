import { taskFilterSchema } from '@core/taskSchema.js'
import type { Task, TaskFilter } from '@core/types.js'
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
  /** The task-file operations, from `core/taskStore.ts`. */
  store: Pick<
    TaskWritePorts,
    | 'createTask'
    | 'updateTask'
    | 'addNote'
    | 'reorderTasks'
    | 'setArchived'
    | 'deleteTask'
    | 'removeWorktree'
  > & { brokenTaskFiles(): { filePath: string; reason: string }[] }
  /** Moves In Review tasks whose work landed to Done; true when it wrote a task file. */
  settleLandedTasks(): boolean
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
   * Re-indexes the active board and tells the renderer. Runs on every task write and every watcher
   * event, so it stays cheap: the index re-reads only changed files, and a landing pass that wrote
   * a file costs one more sync, never a second broadcast.
   */
  function notifyTasksChanged(): void {
    const started = performance.now()
    index.sync()
    if (ports.settleLandedTasks()) index.sync()
    ports.observeTasks(index.query())
    ports.recordNotifyDuration(performance.now() - started)
    ports.broadcast('tasks:changed')
    ports.requestAutoRun()
  }

  const writes = createTaskWrites({
    ...store,
    findTask: index.find,
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
