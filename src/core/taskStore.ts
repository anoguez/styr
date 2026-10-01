import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { jsonTaskSchema } from './taskSchema.js'
import { hasFrontmatter, parseTaskMarkdown, serialiseTask } from './markdown.js'
import { tasksDir } from './config.js'
import type { ActivityEntry, Task, TaskDraft, TaskFilter, TaskPatch, TaskStatus } from './types.js'

const TASK_EXTENSIONS = new Set(['.md', '.markdown', '.json'])
const ID_RE = /^TASK-(\d+)$/

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function now(): string {
  return new Date().toISOString()
}

function taskFilePaths(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.') && TASK_EXTENSIONS.has(extname(name).toLowerCase()))
    .map((name) => join(dir, name))
}

function adoptUnmanaged(raw: string, filePath: string, index: number): Task {
  const heading = /^#\s+(.+)$/m.exec(raw)
  const stamp = now()
  return {
    id: `TASK-${String(index).padStart(4, '0')}`,
    title: heading?.[1]?.trim() ?? basename(filePath, extname(filePath)),
    status: 'backlog',
    priority: 'medium',
    readiness: 'ready',
    orchestrate: true,
    useWorktree: false,
    sessions: [],
    contextFiles: [],
    description: raw.replace(/^#\s+.+$/m, '').trim(),
    activity: [],
    tags: [],
    order: index,
    createdAt: stamp,
    updatedAt: stamp,
    filePath,
    format: 'markdown'
  }
}

const brokenFiles = new Map<string, string>()

export function clearBrokenFiles(): void {
  brokenFiles.clear()
}

export function brokenTaskFiles(): { filePath: string; reason: string }[] {
  return [...brokenFiles.entries()].map(([filePath, reason]) => ({ filePath, reason }))
}

/**
 * A file that already carries frontmatter is a managed task someone edited badly — it is recorded
 * as broken and skipped, never rewritten, because rewriting destroys the fields that failed to parse.
 * Only a file with no frontmatter is adopted.
 */
export function readTaskAtPath(filePath: string, fallbackIndex = 1): Task | null {
  const raw = readFileSync(filePath, 'utf8')
  const isJson = extname(filePath).toLowerCase() === '.json'
  try {
    if (isJson) {
      const parsed = jsonTaskSchema.parse(JSON.parse(raw))
      brokenFiles.delete(filePath)
      return { ...parsed, filePath, format: 'json' }
    }
    const task = parseTaskMarkdown(raw, filePath)
    brokenFiles.delete(filePath)
    return task
  } catch (error) {
    if (isJson || hasFrontmatter(raw)) {
      brokenFiles.set(filePath, error instanceof Error ? error.message : String(error))
      return null
    }
    const adopted = adoptUnmanaged(raw, filePath, fallbackIndex)
    writeTask(adopted)
    brokenFiles.delete(filePath)
    return adopted
  }
}

function writeTask(task: Task): Task {
  if (task.format === 'json') {
    const { filePath: _filePath, format: _format, ...payload } = task
    writeFileSync(task.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    return task
  }
  writeFileSync(task.filePath, serialiseTask(task), 'utf8')
  return task
}

export { taskFilePaths }

export function listTasks(filter: TaskFilter = {}): Task[] {
  const dir = tasksDir()
  clearBrokenFiles()
  const tasks = taskFilePaths(dir)
    .map((filePath, index) => readTaskAtPath(filePath, index + 1))
    .filter((task): task is Task => task !== null)

  const statuses = filter.status
    ? new Set<TaskStatus>(Array.isArray(filter.status) ? filter.status : [filter.status])
    : null
  const needle = filter.query?.toLowerCase()

  return tasks
    .filter((task) => {
      if (statuses && !statuses.has(task.status)) return false
      if (filter.readiness && task.readiness !== filter.readiness) return false
      if (filter.project && task.project !== filter.project) return false
      if (filter.tag && !task.tags.includes(filter.tag)) return false
      if (needle && !`${task.title} ${task.description}`.toLowerCase().includes(needle))
        return false
      return true
    })
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
}

export function getTask(id: string): Task | null {
  return listTasks().find((task) => task.id === id) ?? null
}

function nextId(existing: Task[]): string {
  const highest = existing.reduce((max, task) => {
    const match = ID_RE.exec(task.id)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  return `TASK-${String(highest + 1).padStart(4, '0')}`
}

export function createTask(draft: TaskDraft): Task {
  const existing = listTasks()
  const stamp = now()
  const id = draft.id ?? nextId(existing)
  const status = draft.status ?? 'backlog'
  const task: Task = {
    id,
    title: draft.title,
    status,
    priority: draft.priority ?? 'medium',
    readiness: draft.readiness ?? 'ready',
    description: draft.description ?? '',
    activity: [],
    project: draft.project,
    tags: draft.tags ?? [],
    repoPath: draft.repoPath,
    orchestrate: draft.orchestrate ?? true,
    useWorktree: draft.useWorktree ?? false,
    worktreePath: draft.worktreePath,
    contextFiles: draft.contextFiles ?? [],
    promptTemplateId: draft.promptTemplateId,
    claudeSessionId: draft.claudeSessionId,
    sessions: draft.sessions ?? [],
    externalRef: draft.externalRef,
    order: draft.order ?? existing.filter((task) => task.status === status).length,
    createdAt: stamp,
    updatedAt: stamp,
    filePath: join(tasksDir(), `${id}-${slugify(draft.title)}.md`),
    format: 'markdown'
  }
  return writeTask(task)
}

export function updateTask(id: string, patch: TaskPatch): Task {
  const task = getTask(id)
  if (!task) throw new Error(`Task ${id} not found`)
  return writeTask({ ...task, ...patch, updatedAt: now() })
}

export function addNote(id: string, author: string, message: string): Task {
  const task = getTask(id)
  if (!task) throw new Error(`Task ${id} not found`)
  const entry: ActivityEntry = { at: now(), author, message }
  return writeTask({ ...task, activity: [...task.activity, entry], updatedAt: now() })
}

export function deleteTask(id: string): void {
  const task = getTask(id)
  if (!task) throw new Error(`Task ${id} not found`)
  unlinkSync(task.filePath)
}

export function reorderTasks(status: TaskStatus, orderedIds: string[]): Task[] {
  const byId = new Map(listTasks().map((task) => [task.id, task]))
  return orderedIds.map((id, index) => {
    const task = byId.get(id)
    if (!task) throw new Error(`Task ${id} not found`)
    return writeTask({ ...task, status, order: index, updatedAt: now() })
  })
}
