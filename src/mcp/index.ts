import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { pinWorkspace } from '@core/config.js'
import { addNote, createTask, deleteTask, getTask, listTasks, updateTask } from '@core/taskStore.js'
import { TASK_PRIORITIES, TASK_READINESS, TASK_STATUSES, type Task } from '@core/types.js'

// Registered once for every agent, so the workspace comes from the agent that launched us.
pinWorkspace(process.env.STYR_WORKSPACE_ID)

const AUTHOR = process.env.STYR_MCP_AUTHOR ?? 'claude'

function summarise(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    readiness: task.readiness,
    project: task.project,
    tags: task.tags,
    repoPath: task.repoPath,
    useWorktree: task.useWorktree,
    baseBranch: task.baseBranch,
    worktreePath: task.worktreePath,
    prUrl: task.prUrl,
    contextFiles: task.contextFiles,
    updatedAt: task.updatedAt,
    filePath: task.filePath
  }
}

function json(payload: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

const server = new McpServer({ name: 'styr', version: '0.1.0' })

server.registerTool(
  'list_tasks',
  {
    title: 'List tasks',
    description:
      'List tasks on the Styr board, optionally filtered by status, readiness, project, ' +
      'tag or a text query. readiness "needs_spec" means the task still has to be specified before ' +
      'anyone can work on it.',
    inputSchema: {
      status: z.enum(TASK_STATUSES).optional(),
      readiness: z.enum(TASK_READINESS).optional(),
      project: z.string().optional(),
      tag: z.string().optional(),
      query: z.string().optional()
    }
  },
  async (args) => json(listTasks(args).map(summarise))
)

server.registerTool(
  'get_task',
  {
    title: 'Get task',
    description: 'Fetch one task including its full description and activity log.',
    inputSchema: { id: z.string() }
  },
  async ({ id }) => {
    const task = getTask(id)
    return task ? json(task) : json({ error: `Task ${id} not found` })
  }
)

server.registerTool(
  'create_task',
  {
    title: 'Create task',
    description:
      'Create a task in the backlog (or another status) as a markdown file on the board. ' +
      'baseBranch picks the branch the task worktree starts from when useWorktree is set; unset ' +
      "means the repository checkout's current branch.",
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      readiness: z.enum(TASK_READINESS).optional(),
      project: z.string().optional(),
      tags: z.array(z.string()).optional(),
      repoPath: z.string().optional(),
      useWorktree: z.boolean().optional(),
      baseBranch: z.string().optional(),
      contextFiles: z.array(z.string()).optional()
    }
  },
  async (args) => json(summarise(createTask(args)))
)

server.registerTool(
  'update_task',
  {
    title: 'Update task',
    description:
      'Update any field of a task, including moving it to another board column. Set readiness to ' +
      '"ready" once a task is specified well enough to be worked on, or "needs_spec" when it is not. ' +
      'contextFiles replaces the task attachment list — absolute paths to files worth reading for ' +
      'this task. prUrl is the link to the pull/merge request opened for the task, on any host. ' +
      'baseBranch is the branch the task worktree starts from; it can only be changed before the ' +
      "worktree exists, and unset means the repository checkout's current branch.",
    inputSchema: {
      id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      readiness: z.enum(TASK_READINESS).optional(),
      project: z.string().optional(),
      tags: z.array(z.string()).optional(),
      repoPath: z.string().optional(),
      baseBranch: z.string().optional(),
      contextFiles: z.array(z.string()).optional(),
      prUrl: z.string().optional()
    }
  },
  async ({ id, ...patch }) => {
    const existing = getTask(id)
    if (
      existing?.worktreePath &&
      patch.baseBranch !== undefined &&
      patch.baseBranch !== existing.baseBranch
    ) {
      throw new Error(`${id} already has a worktree, so its base branch can no longer change`)
    }
    return json(summarise(updateTask(id, patch)))
  }
)

server.registerTool(
  'set_task_status',
  {
    title: 'Set task status',
    description: 'Move a task to a board column: backlog, in_progress, in_review or done.',
    inputSchema: { id: z.string(), status: z.enum(TASK_STATUSES), note: z.string().optional() }
  },
  async ({ id, status, note }) => {
    const task = updateTask(id, { status })
    return json(summarise(note ? addNote(task.id, AUTHOR, note) : task))
  }
)

server.registerTool(
  'add_task_note',
  {
    title: 'Add task note',
    description: 'Append a progress note to a task activity log.',
    inputSchema: { id: z.string(), message: z.string(), author: z.string().optional() }
  },
  async ({ id, message, author }) => json(summarise(addNote(id, author ?? AUTHOR, message)))
)

server.registerTool(
  'delete_task',
  {
    title: 'Delete task',
    description: 'Permanently delete a task file from the board.',
    inputSchema: { id: z.string() }
  },
  async ({ id }) => {
    deleteTask(id)
    return json({ deleted: id })
  }
)

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
}

main().catch((error: unknown) => {
  process.stderr.write(`styr mcp failed: ${String(error)}\n`)
  process.exit(1)
})
