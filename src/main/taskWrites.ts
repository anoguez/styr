import { taskDraftSchema, taskPatchSchema } from '@core/taskSchema.js'
import {
  TASK_STATUSES,
  type Task,
  type TaskDraft,
  type TaskPatch,
  type TaskStatus
} from '@core/types.js'

/**
 * Task mutations from the renderer, free of Electron: each operation validates its input, writes
 * through the task store and then re-indexes, so no caller can forget the notify that keeps the
 * board in step. `ipc.ts` supplies the real ports and maps its channels onto the operations.
 */
export interface TaskWritePorts {
  /** Index lookup in the active workspace. */
  findTask(taskId: string): Task | null | undefined
  createTask(draft: TaskDraft): Task
  updateTask(taskId: string, patch: TaskPatch): Task
  addNote(taskId: string, author: string, message: string): Task
  reorderTasks(status: TaskStatus, orderedIds: string[]): Task[]
  setArchived(taskId: string, archived: boolean): Task
  deleteTask(taskId: string): void
  /** Removes the task's git worktree from disk; the task file is updated separately. */
  removeWorktree(task: Task & { repoPath: string }): void
  /** Re-index and broadcast the active workspace's board. */
  notifyTasks(): void
  notifyAgents(): void
}

export function createTaskWrites(ports: TaskWritePorts) {
  /** Runs one write, then notifies once. A write that throws notifies nothing. */
  function write<T>(run: () => T, { agents = false } = {}): T {
    const result = run()
    ports.notifyTasks()
    if (agents) ports.notifyAgents()
    return result
  }

  return {
    create: (draft: unknown): Task => write(() => ports.createTask(taskDraftSchema.parse(draft))),

    update: (taskId: string, patch: unknown): Task =>
      write(() => ports.updateTask(taskId, taskPatchSchema.parse(patch))),

    note: (taskId: string, author: string, message: string): Task =>
      write(() => ports.addNote(taskId, author, message)),

    reorder: (status: TaskStatus, orderedIds: string[]): Task[] => {
      if (!TASK_STATUSES.includes(status)) throw new Error(`Unknown status ${status}`)
      return write(() => ports.reorderTasks(status, orderedIds))
    },

    /** Archived tasks drop out of every agent list, so the agents are re-broadcast too. */
    archive: (taskId: string, archived: boolean): Task =>
      write(() => ports.setArchived(taskId, archived), { agents: true }),

    delete: (taskId: string): void => write(() => ports.deleteTask(taskId)),

    /** Forgets the task's current chat; its session history stays. */
    forgetSession: (taskId: string): Task =>
      write(() => ports.updateTask(taskId, { agentSession: undefined })),

    /**
     * The task-file half of removing an agent from the board, after its terminal and status are
     * gone: forgets the current chat, if any, and re-broadcasts the board and the agents.
     */
    removeAgent: (taskId: string): void =>
      write(
        () => {
          if (ports.findTask(taskId)?.agentSession) {
            ports.updateTask(taskId, { agentSession: undefined })
          }
        },
        { agents: true }
      ),

    /** Returns null, writing nothing, when the task is missing or has no repository. */
    removeWorktree: (taskId: string): Task | null => {
      const task = ports.findTask(taskId)
      if (!task?.repoPath) return null
      const repoPath = task.repoPath
      return write(() => {
        ports.removeWorktree({ ...task, repoPath })
        return ports.updateTask(task.id, { worktreePath: undefined })
      })
    }
  }
}

export type TaskWrites = ReturnType<typeof createTaskWrites>
