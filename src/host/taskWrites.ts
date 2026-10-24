import { answerMessage } from '@core/questions.js'
import { taskDraftSchema, taskPatchSchema } from '@core/taskSchema.js'
import {
  TASK_STATUSES,
  type AnswerResult,
  type Task,
  type TaskDraft,
  type TaskPatch,
  type TaskStatus
} from '@core/types.js'

/**
 * Task mutations from the renderer, free of Electron: each operation validates its input, writes
 * through the task store and then re-indexes, so no caller can forget the notify that keeps the
 * board in step. The tasks service (`tasksService.ts`) supplies the ports and exposes the operations.
 */
export interface TaskWritePorts {
  /** Index lookup in the active workspace. */
  findTask(taskId: string): Task | null | undefined
  createTask(draft: TaskDraft): Task
  updateTask(taskId: string, patch: TaskPatch): Task
  addNote(taskId: string, author: string, message: string): Task
  reorderTasks(status: TaskStatus, orderedIds: string[]): Task[]
  setArchived(taskId: string, archived: boolean): Task
  /** Records the owner's answer and its note; throws when the question is missing or answered. */
  answerQuestion(taskId: string, questionId: string, answer: string): Task
  /** How a message would reach the task's agent, and the delivery (`sessionLifecycle`). */
  route(taskId: string): { route: 'queued' | 'now' | 'resume' | 'fresh' }
  deliver(taskId: string, message: string): Promise<unknown>
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

    /**
     * Records an owner's answer, then sends it to the agent by the Request changes routes. The
     * answer is kept whatever happens to the delivery, and a question answered once is refused,
     * so it is never sent twice. A task with no chat to resume is not launched for an answer: the
     * agent reads it from its prompt next time. The task's status is not touched.
     */
    answerQuestion: async (
      taskId: string,
      questionId: string,
      answer: string
    ): Promise<AnswerResult> => {
      const task = write(() => ports.answerQuestion(taskId, questionId, answer))
      const question = task.questions.find((candidate) => candidate.id === questionId)
      if (!question?.answer) return { task, delivery: 'recorded' }
      const { route } = ports.route(taskId)
      if (route === 'fresh') return { task, delivery: 'recorded' }
      try {
        await ports.deliver(taskId, answerMessage(question, question.answer))
        return { task, delivery: route }
      } catch (error) {
        return {
          task,
          delivery: 'failed',
          error: error instanceof Error ? error.message : String(error)
        }
      }
    },

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
