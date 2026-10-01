import matter from 'gray-matter'
import { taskFrontmatterSchema } from './taskSchema.js'
import type { ActivityEntry, Task } from './types.js'

const ACTIVITY_MARKER = '<!-- styr:activity -->'
const TOKEN_FIELDS = ['status', 'priority', 'readiness'] as const
const TIMESTAMP_FIELDS = ['createdAt', 'updatedAt'] as const
const ENTRY_RE = /^- `([^`]+)` \*\*([^*]+)\*\* — (.*)$/

function renderActivity(activity: ActivityEntry[]): string {
  if (activity.length === 0) return ''
  const lines = activity.map((entry) => {
    const [first = '', ...rest] = entry.message.split('\n')
    const head =
      entry.at && entry.author ? `- \`${entry.at}\` **${entry.author}** — ${first}` : `- ${first}`
    return [head, ...rest.map((line) => `  ${line}`)].join('\n')
  })
  return [ACTIVITY_MARKER, '## Activity', '', ...lines, ''].join('\n')
}

function parseActivity(block: string): ActivityEntry[] {
  const entries: ActivityEntry[] = []
  for (const line of block.split('\n')) {
    const match = ENTRY_RE.exec(line)
    if (match) {
      entries.push({
        at: match[1] as string,
        author: match[2] as string,
        message: match[3] as string
      })
      continue
    }
    if (line.startsWith('- ')) {
      entries.push({ at: '', author: '', message: line.slice(2) })
      continue
    }
    const current = entries[entries.length - 1]
    if (current && line.startsWith('  ')) current.message += `\n${line.slice(2)}`
  }
  return entries
}

export function hasFrontmatter(raw: string): boolean {
  return /^\uFEFF?---\r?\n/.test(raw)
}

function normaliseToken(value: unknown): unknown {
  return typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
    : value
}

function tolerate(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data }
  for (const field of TOKEN_FIELDS) {
    if (field in out) out[field] = normaliseToken(out[field])
  }
  for (const field of TIMESTAMP_FIELDS) {
    if (out[field] instanceof Date) out[field] = out[field].toISOString()
  }
  return out
}

export function serialiseTask(task: Task): string {
  const body = [task.description.trim(), renderActivity(task.activity)]
    .filter((part) => part.length > 0)
    .join('\n\n')
  return matter.stringify(`${body}\n`, {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    readiness: task.readiness,
    ...(task.project ? { project: task.project } : {}),
    tags: task.tags,
    ...(task.repoPath ? { repoPath: task.repoPath } : {}),
    ...(task.orchestrate ? {} : { orchestrate: false }),
    ...(task.useWorktree ? { useWorktree: true } : {}),
    ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
    ...(task.contextFiles.length > 0 ? { contextFiles: task.contextFiles } : {}),
    ...(task.promptTemplateId ? { promptTemplateId: task.promptTemplateId } : {}),
    ...(task.claudeSessionId ? { claudeSessionId: task.claudeSessionId } : {}),
    ...(task.sessions.length > 0 ? { sessions: task.sessions } : {}),
    ...(task.externalRef ? { externalRef: task.externalRef } : {}),
    order: task.order,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  })
}

export function parseTaskMarkdown(raw: string, filePath: string): Task {
  const parsed = matter(raw)
  const front = taskFrontmatterSchema.parse(tolerate(parsed.data))
  const markerAt = parsed.content.indexOf(ACTIVITY_MARKER)
  const description = (markerAt === -1 ? parsed.content : parsed.content.slice(0, markerAt)).trim()
  const activity = markerAt === -1 ? [] : parseActivity(parsed.content.slice(markerAt))
  return { ...front, description, activity, filePath, format: 'markdown' }
}
