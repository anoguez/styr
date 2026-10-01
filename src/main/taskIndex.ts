import { statSync } from 'node:fs'
import Database from 'better-sqlite3'
import { indexDbPath, tasksDir } from '@core/config.js'
import { clearBrokenFiles, readTaskAtPath, taskFilePaths } from '@core/taskStore.js'
import type { Task, TaskFilter, TaskStatus } from '@core/types.js'

const SCHEMA_VERSION = 9

interface IndexRow {
  id: string
  title: string
  status: TaskStatus
  priority: Task['priority']
  readiness: Task['readiness']
  project: string | null
  tags: string
  repoPath: string | null
  orchestrate: number
  useWorktree: number
  worktreePath: string | null
  contextFiles: string
  promptTemplateId: string | null
  provider: string | null
  claudeSessionId: string | null
  agentSession: string | null
  sessions: string
  externalRef: string | null
  description: string
  activity: string
  sort_order: number
  createdAt: string
  updatedAt: string
  filePath: string
  format: Task['format']
}

let db: Database.Database | null = null

function connection(): Database.Database {
  if (db) return db
  db = new Database(indexDbPath())
  db.pragma('journal_mode = WAL')

  const [version] = db.pragma('user_version') as [{ user_version: number }]
  if (version.user_version !== SCHEMA_VERSION) {
    db.exec('DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS files;')
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      readiness TEXT NOT NULL,
      project TEXT,
      tags TEXT NOT NULL,
      repoPath TEXT,
      orchestrate INTEGER NOT NULL,
      useWorktree INTEGER NOT NULL,
      worktreePath TEXT,
      contextFiles TEXT NOT NULL,
      promptTemplateId TEXT,
      provider TEXT,
      claudeSessionId TEXT,
      agentSession TEXT,
      sessions TEXT NOT NULL,
      externalRef TEXT,
      description TEXT NOT NULL,
      activity TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      filePath TEXT NOT NULL UNIQUE,
      format TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      filePath TEXT PRIMARY KEY,
      mtimeMs REAL NOT NULL,
      taskId TEXT
    );
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, sort_order);
  `)
  return db
}

function toRow(task: Task): IndexRow {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    readiness: task.readiness,
    project: task.project ?? null,
    tags: JSON.stringify(task.tags),
    repoPath: task.repoPath ?? null,
    orchestrate: task.orchestrate ? 1 : 0,
    useWorktree: task.useWorktree ? 1 : 0,
    worktreePath: task.worktreePath ?? null,
    contextFiles: JSON.stringify(task.contextFiles),
    promptTemplateId: task.promptTemplateId ?? null,
    provider: task.provider ?? null,
    claudeSessionId: task.claudeSessionId ?? null,
    agentSession: task.agentSession ? JSON.stringify(task.agentSession) : null,
    sessions: JSON.stringify(task.sessions),
    externalRef: task.externalRef ? JSON.stringify(task.externalRef) : null,
    description: task.description,
    activity: JSON.stringify(task.activity),
    sort_order: task.order,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    filePath: task.filePath,
    format: task.format
  }
}

function fromRow(row: IndexRow): Task {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    readiness: row.readiness,
    project: row.project ?? undefined,
    tags: JSON.parse(row.tags) as string[],
    repoPath: row.repoPath ?? undefined,
    orchestrate: row.orchestrate === 1,
    useWorktree: row.useWorktree === 1,
    worktreePath: row.worktreePath ?? undefined,
    contextFiles: JSON.parse(row.contextFiles) as string[],
    promptTemplateId: row.promptTemplateId ?? undefined,
    provider: (row.provider as Task['provider']) ?? undefined,
    claudeSessionId: row.claudeSessionId ?? undefined,
    agentSession: row.agentSession
      ? (JSON.parse(row.agentSession) as Task['agentSession'])
      : undefined,
    sessions: JSON.parse(row.sessions) as Task['sessions'],
    externalRef: row.externalRef ? (JSON.parse(row.externalRef) as Task['externalRef']) : undefined,
    description: row.description,
    activity: JSON.parse(row.activity) as Task['activity'],
    order: row.sort_order,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    filePath: row.filePath,
    format: row.format
  }
}

const UPSERT = `
  INSERT INTO tasks (id, title, status, priority, readiness, project, tags, repoPath, orchestrate,
                     useWorktree, worktreePath, contextFiles, promptTemplateId, provider, claudeSessionId, agentSession, sessions, externalRef,
                     description, activity, sort_order, createdAt, updatedAt, filePath, format)
  VALUES (@id, @title, @status, @priority, @readiness, @project, @tags, @repoPath, @orchestrate,
          @useWorktree, @worktreePath, @contextFiles, @promptTemplateId, @provider, @claudeSessionId, @agentSession, @sessions, @externalRef,
          @description, @activity, @sort_order, @createdAt, @updatedAt, @filePath, @format)
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title, status=excluded.status, priority=excluded.priority,
    readiness=excluded.readiness, project=excluded.project,
    tags=excluded.tags, repoPath=excluded.repoPath, orchestrate=excluded.orchestrate, useWorktree=excluded.useWorktree,
    worktreePath=excluded.worktreePath, contextFiles=excluded.contextFiles,
    promptTemplateId=excluded.promptTemplateId, provider=excluded.provider, claudeSessionId=excluded.claudeSessionId, agentSession=excluded.agentSession, sessions=excluded.sessions,
    externalRef=excluded.externalRef, description=excluded.description, activity=excluded.activity,
    sort_order=excluded.sort_order, createdAt=excluded.createdAt, updatedAt=excluded.updatedAt,
    filePath=excluded.filePath, format=excluded.format
`

export function syncIndex(): void {
  const database = connection()
  const dir = tasksDir()
  clearBrokenFiles()
  const paths = taskFilePaths(dir)
  const known = new Map(
    database
      .prepare('SELECT filePath, mtimeMs, taskId FROM files')
      .all()
      .map((row) => {
        const file = row as { filePath: string; mtimeMs: number; taskId: string | null }
        return [file.filePath, file]
      })
  )

  const upsertTask = database.prepare(UPSERT)
  const upsertFile = database.prepare(
    'INSERT INTO files (filePath, mtimeMs, taskId) VALUES (?, ?, ?) ' +
      'ON CONFLICT(filePath) DO UPDATE SET mtimeMs=excluded.mtimeMs, taskId=excluded.taskId'
  )
  const dropTask = database.prepare('DELETE FROM tasks WHERE id = ?')
  const dropFile = database.prepare('DELETE FROM files WHERE filePath = ?')

  database.transaction(() => {
    paths.forEach((filePath, position) => {
      const mtimeMs = statSync(filePath).mtimeMs
      const previous = known.get(filePath)
      known.delete(filePath)
      if (previous && previous.mtimeMs === mtimeMs) return
      const task = readTaskAtPath(filePath, position + 1)
      if (!task) return
      upsertTask.run(toRow(task) as unknown as Record<string, unknown>)
      upsertFile.run(filePath, mtimeMs, task.id)
    })

    for (const stale of known.values()) {
      if (stale.taskId) dropTask.run(stale.taskId)
      dropFile.run(stale.filePath)
    }
  })()
}

export function queryTasks(filter: TaskFilter = {}): Task[] {
  const database = connection()
  const clauses: string[] = []
  const params: unknown[] = []

  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
    clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }
  if (filter.readiness) {
    clauses.push('readiness = ?')
    params.push(filter.readiness)
  }
  if (filter.project) {
    clauses.push('project = ?')
    params.push(filter.project)
  }
  if (filter.tag) {
    clauses.push('tags LIKE ?')
    params.push(`%"${filter.tag}"%`)
  }
  if (filter.query) {
    clauses.push('(title LIKE ? OR description LIKE ?)')
    params.push(`%${filter.query}%`, `%${filter.query}%`)
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = database
    .prepare(`SELECT * FROM tasks ${where} ORDER BY sort_order ASC, createdAt ASC`)
    .all(...params) as IndexRow[]
  return rows.map(fromRow)
}

export function findTask(id: string): Task | null {
  const row = connection().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
    IndexRow | undefined
  return row ? fromRow(row) : null
}

export function closeIndex(): void {
  db?.close()
  db = null
}
