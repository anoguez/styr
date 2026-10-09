import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { agentKey, isAgentArchived, type AgentStatus } from './agentState.js'
import { awaitsReview } from './inbox.js'
import { readAllAgentStatuses } from './agentStore.js'
import { pathsInWorkspace, workspaceDir } from './config.js'
import { saveWorkspaceSettings } from './settingsStore.js'
import { parseTaskMarkdown } from './markdown.js'
import {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  type Settings,
  type Task,
  type TaskReadiness,
  type TaskStatus,
  type WorkspaceInfo,
  type WorkspaceSettings
} from './types.js'

const MARKER = 'workspace.json'
const NAME_LIMIT = 40

function workspacesRoot(settings: Settings): string {
  return join(settings.storageDir, 'workspaces')
}

function readName(settings: Settings, id: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(workspaceDir(settings, id), MARKER), 'utf8')) as {
      name?: unknown
    }
    return typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id
  } catch {
    return id
  }
}

/**
 * Every workspace, Default first and the rest by name. Read from the folders, so the list needs no
 * registry that could disagree with the disk — and it travels with a versioned storage folder. A
 * folder without a readable `workspace.json` is still a workspace, named after its folder.
 */
export function listWorkspaces(settings: Settings): WorkspaceInfo[] {
  const root = workspacesRoot(settings)
  const others = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ id: entry.name, name: readName(settings, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : []
  return [{ id: DEFAULT_WORKSPACE_ID, name: DEFAULT_WORKSPACE_NAME }, ...others]
}

export function workspaceSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'workspace'
  )
}

/** A trimmed name that no other workspace already has, compared without regard to case. */
export function validateWorkspaceName(settings: Settings, name: string, ignoreId?: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Give the workspace a name.')
  if (trimmed.length > NAME_LIMIT) throw new Error(`Keep the name under ${NAME_LIMIT} characters.`)
  const clash = listWorkspaces(settings).find(
    (workspace) =>
      workspace.id !== ignoreId && workspace.name.toLowerCase() === trimmed.toLowerCase()
  )
  if (clash) throw new Error(`A workspace called “${clash.name}” already exists.`)
  return trimmed
}

function writeMarker(settings: Settings, id: string, name: string): void {
  writeFileSync(
    join(workspaceDir(settings, id), MARKER),
    `${JSON.stringify({ name }, null, 2)}\n`,
    'utf8'
  )
}

/** Ids never change after creation (renaming edits the name only), and "A B" and "a-b" both get one. */
function uniqueId(settings: Settings, name: string): string {
  const taken = new Set(listWorkspaces(settings).map((workspace) => workspace.id))
  const base = workspaceSlug(name)
  let id = base
  for (let n = 2; taken.has(id) || existsSync(workspaceDir(settings, id)); n += 1) {
    id = `${base}-${n}`
  }
  return id
}

/**
 * `seed` becomes the new workspace's own settings file, so later changes to the workspace it was
 * copied from never leak into it.
 */
export function createWorkspace(
  settings: Settings,
  name: string,
  seed: WorkspaceSettings
): WorkspaceInfo {
  const validName = validateWorkspaceName(settings, name)
  const id = uniqueId(settings, validName)
  mkdirSync(join(workspaceDir(settings, id), 'tasks'), { recursive: true })
  writeMarker(settings, id, validName)
  saveWorkspaceSettings({ ...settings, ...seed }, id)
  return { id, name: validName }
}

export function renameWorkspace(settings: Settings, id: string, name: string): WorkspaceInfo {
  if (id === DEFAULT_WORKSPACE_ID) throw new Error('The Default workspace cannot be renamed.')
  if (!existsSync(workspaceDir(settings, id))) throw new Error('That workspace no longer exists.')
  const validName = validateWorkspaceName(settings, name, id)
  writeMarker(settings, id, validName)
  return { id, name: validName }
}

const TASK_FILE = new Set(['.md', '.markdown', '.json'])

export function workspaceTaskCount(settings: Settings, id: string): number {
  const dir = join(workspaceDir(settings, id), 'tasks')
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter(
    (name) => !name.startsWith('.') && TASK_FILE.has(extname(name).toLowerCase())
  ).length
}

export interface TaskSummary {
  title: string
  status: TaskStatus
  readiness: TaskReadiness
  archivedAt?: string
}

/**
 * A workspace's markdown tasks, parsed without side effects — for workspaces whose index is not
 * open, where nothing may adopt or rewrite a file. A file that does not parse is skipped, as the
 * index skips it.
 */
export function readWorkspaceTasks(settings: Settings, id: string): Task[] {
  const dir = join(workspaceDir(settings, id), 'tasks')
  if (!existsSync(dir)) return []
  const tasks: Task[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || !['.md', '.markdown'].includes(extname(name).toLowerCase()))
      continue
    try {
      const filePath = join(dir, name)
      tasks.push(parseTaskMarkdown(readFileSync(filePath, 'utf8'), filePath))
    } catch {
      // a half-edited file is left for the user to fix
    }
  }
  return tasks
}

/** Titles and statuses of a workspace's tasks, for the menu bar. Reads like `readWorkspaceTasks`. */
export function readTaskSummaries(settings: Settings, id: string): Map<string, TaskSummary> {
  return new Map(
    readWorkspaceTasks(settings, id).map((task) => [
      task.id,
      {
        title: task.title,
        status: task.status,
        readiness: task.readiness,
        archivedAt: task.archivedAt
      }
    ])
  )
}

export interface BackgroundAgents {
  statuses: AgentStatus[]
  /** Task titles keyed like `agentKey`, for the menu. */
  titles: Map<string, string>
  /** `agentKey`s of agents whose task awaits your review, for the workspace switcher. */
  awaitingReview: Set<string>
}

/**
 * Agents of every workspace except the active one, tagged with where they live. The menu bar and
 * notifications span all workspaces, but the board only holds the active one's index, so these are
 * read from disk — and task files are parsed only for a workspace that has agent records at all,
 * because this runs on every hook event.
 */
export function readBackgroundAgents(settings: Settings, activeId: string): BackgroundAgents {
  const statuses: AgentStatus[] = []
  const titles = new Map<string, string>()
  const awaitingReview = new Set<string>()
  for (const workspace of listWorkspaces(settings)) {
    if (workspace.id === activeId) continue
    const scoped = pathsInWorkspace(settings, workspace.id)
    const found = readAllAgentStatuses(scoped, { subagents: false })
    if (found.length === 0) continue
    const summaries = readTaskSummaries(settings, workspace.id)
    for (const status of found) {
      const summary = summaries.get(status.taskId)
      if (summary && isAgentArchived(summary)) continue
      const tagged = { ...status, workspaceId: workspace.id, workspaceName: workspace.name }
      statuses.push(tagged)
      if (!summary) continue
      titles.set(agentKey(tagged), summary.title)
      if (awaitsReview(summary, status.state)) awaitingReview.add(agentKey(tagged))
    }
  }
  return { statuses, titles, awaitingReview }
}
