import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { indexTasks, openBlockers } from '@core/blocking.js'
import { pinWorkspace } from '@core/config.js'
import { adapterFor, currentSources, runCommand, writableSource } from '@core/sources/index.js'
import { openQuestions } from '@core/questions.js'
import { requestReview, taskHandoff } from '@core/reviewRequest.js'
import { MAX_SPLIT_CHILDREN, splitTask } from '@core/taskSplit.js'
import { mergeExtraPrUrls } from '@core/taskPullRequests.js'
import {
  addNote,
  askQuestion,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  updateTask
} from '@core/taskStore.js'
import { TASK_ID_RE } from '@core/taskSchema.js'
import { TASK_PRIORITIES, TASK_READINESS, TASK_STATUSES, type Task } from '@core/types.js'

// Registered once for every agent, so the workspace comes from the agent that launched us.
pinWorkspace(process.env.STYR_WORKSPACE_ID)

const AUTHOR = process.env.STYR_MCP_AUTHOR ?? 'claude'

/** What still holds a task back. Computed on every call: blocked is derived, never stored. */
function blockedByOpen(task: Task): string[] {
  return openBlockers(task, indexTasks(listTasks())).map((blocker) => blocker.id)
}

const blockedByInput = z
  .array(z.string().regex(TASK_ID_RE, 'Use a task id like TASK-0012'))
  .optional()

function summarise(task: Task, open: string[] = blockedByOpen(task)): Record<string, unknown> {
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
    blockedBy: task.blockedBy,
    blockedByOpen: open,
    prUrl: task.prUrl,
    ...(task.extraRepos.length > 0 ? { extraRepos: task.extraRepos } : {}),
    contextFiles: task.contextFiles,
    questions: task.questions,
    openQuestions: openQuestions(task).length,
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
      'tag, a text query or whether it is blocked. readiness "needs_spec" means the task still has to be specified before ' +
      'anyone can work on it.',
    inputSchema: {
      status: z.enum(TASK_STATUSES).optional(),
      readiness: z.enum(TASK_READINESS).optional(),
      project: z.string().optional(),
      tag: z.string().optional(),
      query: z.string().optional(),
      blocked: z
        .boolean()
        .optional()
        .describe('true: only tasks waiting on an unfinished blocker; false: only the rest')
    }
  },
  async ({ blocked, ...filter }) => {
    const byId = indexTasks(listTasks())
    const rows = listTasks(filter).map((task) => ({
      task,
      open: openBlockers(task, byId).map((blocker) => blocker.id)
    }))
    return json(
      rows
        .filter(({ open }) => blocked === undefined || open.length > 0 === blocked)
        .map(({ task, open }) => summarise(task, open))
    )
  }
)

server.registerTool(
  'get_task',
  {
    title: 'Get task',
    description:
      'Fetch one task including its full description, activity log, questions and the latest ' +
      'handoff (the `## Handoff` section, when there is one).',
    inputSchema: { id: z.string() }
  },
  async ({ id }) => {
    const task = getTask(id)
    return task
      ? json({
          ...task,
          blockedByOpen: blockedByOpen(task),
          openQuestions: openQuestions(task).length,
          handoff: taskHandoff(task) ?? null
        })
      : json({ error: `Task ${id} not found` })
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
      blockedBy: blockedByInput,
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
      'this task. prUrl is the link to the pull/merge request opened for the task, on any host (for a task ' +
      "that spans several repositories, the primary repository's). extraRepos records a PR for each other " +
      'repository: entries are matched by repoPath and only their prUrl is applied; the list itself is never ' +
      'replaced and repositories cannot be added or removed. ' +
      'baseBranch is the branch the task worktree starts from; it can only be changed before the ' +
      "worktree exists, and unset means the repository checkout's current branch. blockedBy lists the " +
      'ids of tasks in this workspace that must be Done before this one starts; it replaces the list ' +
      'and [] clears it. Unknown ids and dependency cycles are rejected.',
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
      blockedBy: blockedByInput,
      contextFiles: z.array(z.string()).optional(),
      prUrl: z.string().optional(),
      extraRepos: z
        .array(z.object({ repoPath: z.string(), prUrl: z.string().optional() }))
        .optional()
    }
  },
  async ({ id, extraRepos, ...patch }) => {
    const existing = getTask(id)
    if (
      existing?.worktreePath &&
      patch.baseBranch !== undefined &&
      patch.baseBranch !== existing.baseBranch
    ) {
      throw new Error(`${id} already has a worktree, so its base branch can no longer change`)
    }
    const merged =
      existing && extraRepos ? mergeExtraPrUrls(existing.extraRepos, extraRepos) : undefined
    return json(summarise(updateTask(id, merged ? { ...patch, extraRepos: merged } : patch)))
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
  'split_task',
  {
    title: 'Split task',
    description:
      'Break a task that is too big for one change into smaller ones: creates the children in ' +
      'Backlog (inheriting the repo, worktree, base branch, provider and project) and turns the ' +
      'parent into a blocked umbrella that waits for all of them. Use `after` (0-based indexes of ' +
      'earlier children in this call) to order the children; `blockedBy` is for existing tasks. ' +
      'Invalid input writes nothing.',
    inputSchema: {
      id: z.string().describe('The task to split'),
      children: z
        .array(
          z.object({
            title: z.string().min(1),
            description: z.string().optional(),
            priority: z.enum(TASK_PRIORITIES).optional(),
            tags: z.array(z.string()).optional(),
            readiness: z.enum(TASK_READINESS).optional(),
            after: z.array(z.number().int().min(0)).optional(),
            blockedBy: blockedByInput
          })
        )
        .min(1)
        .max(MAX_SPLIT_CHILDREN)
    }
  },
  async ({ id, children }) => {
    const { parent, children: made } = splitTask(id, children, AUTHOR)
    return json({ ...summarise(parent), children: made.map((child) => summarise(child)) })
  }
)

server.registerTool(
  'request_review',
  {
    title: 'Request review',
    description:
      'Hand the task to the owner for review: moves it to In Review with a handoff summary. ' +
      'Prefer this to set_task_status in_review. Say what changed and how to check it; call it ' +
      'again after changes were requested to replace the handoff.',
    inputSchema: {
      id: z.string(),
      summary: z.object({
        changed: z.string().trim().min(1).describe('What changed'),
        why: z.string().optional(),
        verify: z.string().trim().min(1).describe('How the owner can check it'),
        openQuestions: z.string().optional(),
        notes: z.string().optional()
      }),
      prUrl: z
        .string()
        .optional()
        .describe(
          "The pull/merge request, if one is open (the primary repository's, on a multi-repo task)"
        ),
      extraRepos: z
        .array(z.object({ repoPath: z.string(), prUrl: z.string().optional() }))
        .optional()
        .describe("A multi-repo task's other repositories: each one's repoPath and its PR")
    }
  },
  async ({ id, summary, prUrl, extraRepos }) => {
    const { task, openQuestions: open } = requestReview({
      id,
      summary,
      prUrl,
      extraRepos,
      author: AUTHOR
    })
    return json({ ...summarise(task), openQuestions: open })
  }
)

server.registerTool(
  'ask_owner',
  {
    title: 'Ask the owner',
    description:
      'Ask the owner a question you cannot decide yourself. It shows in their Inbox and the ' +
      'answer is sent back to you. Carry on with whatever does not depend on it, or stop and say ' +
      'you are waiting. Does not change the status.',
    inputSchema: {
      id: z.string(),
      question: z.string().trim().min(1),
      context: z.string().optional().describe('Background the owner needs to answer')
    }
  },
  async ({ id, question, context }) => {
    const text = context?.trim() ? `${question.trim()}\n\n${context.trim()}` : question
    const { task, questionId } = askQuestion(id, AUTHOR, text)
    return json({ questionId, openQuestions: openQuestions(task).length })
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

server.registerTool(
  'list_sources',
  {
    title: 'List external sources',
    description:
      'List the external integrations (such as GitHub) set up for this workspace, with ' +
      'their access level. A read-only source must never be changed.',
    inputSchema: {}
  },
  async () =>
    json(
      currentSources().map(({ id, provider, name, access, enabled }) => ({
        id,
        provider,
        ...(name ? { name } : {}),
        access,
        enabled
      }))
    )
)

server.registerTool(
  'comment_on_source_item',
  {
    title: 'Comment on an external item',
    description:
      'Post a comment on an item (issue) of an external source. Fails with an error when the ' +
      'source is read-only or disabled; do not look for another way to write to it.',
    inputSchema: {
      sourceId: z.string(),
      repo: z.string().describe('The repository, e.g. owner/name'),
      itemId: z.string(),
      body: z.string().min(1)
    }
  },
  async ({ sourceId, repo, itemId, body }) => {
    try {
      const writer = writableSource(sourceId, repo)
      const provider = currentSources().find((source) => source.id === sourceId)?.provider ?? ''
      const status = await adapterFor(provider)?.status(runCommand)
      if (status && status.state !== 'ready') return json({ error: `The CLI is ${status.state}.` })
      await writer.comment(itemId, body)
      return json({ commented: itemId })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) })
    }
  }
)

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
}

main().catch((error: unknown) => {
  process.stderr.write(`styr mcp failed: ${String(error)}\n`)
  process.exit(1)
})
