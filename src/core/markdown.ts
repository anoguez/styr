import matter from 'gray-matter'
import { migrateProviderFields } from './migrateTask.js'
import { TASK_ID_RE, taskFrontmatterSchema } from './taskSchema.js'
import { MAX_EXTRA_REPOS, type ActivityEntry, type ExtraRepo, type Task } from './types.js'

const ACTIVITY_MARKER = '<!-- styr:activity -->'
// A hand-written file may carry the heading without the marker; the marker is only ever written by us.
const ACTIVITY_HEADING_RE = /^## Activity[ \t]*$/m
const TOKEN_FIELDS = ['status', 'priority', 'readiness'] as const
const TIMESTAMP_FIELDS = ['createdAt', 'updatedAt', 'doneAt', 'archivedAt'] as const
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

// A heading or a thematic break at the start of a line: where an Activity section ends.
const SECTION_END_RE = /^(#{1,6}\s|(-{3,}|\*{3,}|_{3,})\s*$)/

/**
 * The notes under `## Activity` (`block` starts after its heading), and whatever follows the
 * section: content an agent appended below Activity (a spec, say) goes back to the description, so
 * a rewrite moves it above the section instead of dropping it. Every other line is kept too: one
 * that is not a note joins the note before it as written, so nothing in the file is ever lost.
 */
function parseActivity(block: string): { entries: ActivityEntry[]; rest: string } {
  const entries: ActivityEntry[] = []
  const lines = block.split('\n')
  for (const [index, line] of lines.entries()) {
    if (SECTION_END_RE.test(line)) return { entries, rest: lines.slice(index).join('\n').trim() }
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
    // An indented line continues the note, a blank one ("  ") included; a bare blank line is spacing.
    if (current && line.startsWith('  ')) current.message += `\n${line.slice(2)}`
    else if (!line.trim()) continue
    else if (current) current.message += `\n${line}`
    else entries.push({ at: '', author: '', message: line })
  }
  return { entries, rest: '' }
}

export function hasFrontmatter(raw: string): boolean {
  return /^\uFEFF?---\r?\n/.test(raw)
}

/** A hand-written model: YAML reads `model: 4` as a number, and a blank one means the default. */
function normaliseModel(value: unknown): unknown {
  const text = typeof value === 'number' ? String(value) : value
  return typeof text === 'string' ? text.trim() || undefined : text
}

function normaliseToken(value: unknown): unknown {
  return typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
    : value
}

/** A hand-written blocker list: one id or several, any case. Entries that are not ids are dropped. */
function normaliseBlockers(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const ids = items
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toUpperCase())
    .filter((item) => TASK_ID_RE.test(item))
  return [...new Set(ids)]
}

function trimTrailingSlashes(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  // "/" and "C:\\" are whole paths, not paths with a slash to trim.
  return trimmed || path.trim()
}

/** Case-insensitive on Windows paths is not guessed at: two spellings of one folder are one repo. */
function repoKey(path: string): string {
  return trimTrailingSlashes(path).replace(/\\/g, '/')
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

/**
 * A hand-written `extraRepos`: one mapping or a list, an entry may be a bare path. Entries without
 * a usable `repoPath`, repeats of the primary repo or of an earlier entry are dropped, trailing
 * slashes are trimmed and the list is capped. Anything else in an entry is kept as written.
 */
export function normaliseExtraRepos(value: unknown, primary: unknown): ExtraRepo[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const seen = new Set<string>()
  if (typeof primary === 'string' && primary.trim()) seen.add(repoKey(primary))
  const out: ExtraRepo[] = []
  for (const item of items) {
    const entry =
      typeof item === 'string'
        ? { repoPath: item }
        : item && typeof item === 'object' && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : undefined
    const repoPath = typeof entry?.repoPath === 'string' ? trimTrailingSlashes(entry.repoPath) : ''
    if (!entry || !repoPath || seen.has(repoKey(repoPath))) continue
    seen.add(repoKey(repoPath))
    const baseBranch = optionalText(entry.baseBranch)
    const worktreePath = optionalText(entry.worktreePath)
    const prUrl = optionalText(entry.prUrl)
    out.push({
      repoPath,
      ...(baseBranch ? { baseBranch } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      ...(prUrl ? { prUrl } : {})
    })
    if (out.length === MAX_EXTRA_REPOS) break
  }
  return out
}

function textOf(value: unknown): string | undefined {
  const text = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value
  return typeof text === 'string' && text.trim() ? text.trim() : undefined
}

function stampOf(value: unknown): string | undefined {
  return value instanceof Date ? value.toISOString() : textOf(value)
}

/**
 * A hand-written `questions:` list. A bare string is an open question; missing parts are filled in
 * (next free `qN`, the file's `updatedAt`, `unknown`); an entry with no text, or one that is not a
 * string or a map, is dropped. It never fails the file.
 */
function normaliseQuestions(value: unknown, fallbackAt: string): unknown[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const used = new Set<string>()
  for (const item of items) {
    const id = item && typeof item === 'object' ? textOf((item as Record<string, unknown>).id) : ''
    if (id) used.add(id)
  }
  let next = 1
  const freeId = (): string => {
    while (used.has(`q${next}`)) next++
    const id = `q${next}`
    used.add(id)
    return id
  }
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const item of items) {
    const entry: Record<string, unknown> =
      typeof item === 'string' || typeof item === 'number'
        ? { text: item }
        : item && typeof item === 'object' && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : {}
    const text = textOf(entry.text)
    if (!text) continue
    let id = textOf(entry.id)
    if (!id || seen.has(id)) id = freeId()
    seen.add(id)
    const answer = textOf(entry.answer)
    out.push({
      id,
      askedAt: stampOf(entry.askedAt) ?? fallbackAt,
      askedBy: textOf(entry.askedBy) ?? 'unknown',
      text,
      ...(answer
        ? {
            answer,
            answeredAt: stampOf(entry.answeredAt) ?? fallbackAt,
            answeredBy: textOf(entry.answeredBy) ?? 'owner'
          }
        : {})
    })
  }
  return out
}

function tolerate(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data }
  for (const field of TOKEN_FIELDS) {
    if (field in out) out[field] = normaliseToken(out[field])
  }
  if ('blockedBy' in out) out.blockedBy = normaliseBlockers(out.blockedBy)
  if ('model' in out) out.model = normaliseModel(out.model)
  if ('extraRepos' in out) out.extraRepos = normaliseExtraRepos(out.extraRepos, out.repoPath)
  for (const field of TIMESTAMP_FIELDS) {
    if (out[field] instanceof Date) out[field] = out[field].toISOString()
  }
  if ('questions' in out) {
    out.questions = normaliseQuestions(
      out.questions,
      stampOf(out.updatedAt) ?? new Date(0).toISOString()
    )
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
    ...(task.baseBranch ? { baseBranch: task.baseBranch } : {}),
    ...(task.blockedBy.length > 0 ? { blockedBy: task.blockedBy } : {}),
    ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
    ...(task.extraRepos.length > 0 ? { extraRepos: task.extraRepos } : {}),
    ...(task.contextFiles.length > 0 ? { contextFiles: task.contextFiles } : {}),
    ...(task.promptTemplateId ? { promptTemplateId: task.promptTemplateId } : {}),
    ...(task.provider ? { provider: task.provider } : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(task.agentSession ? { agentSession: task.agentSession } : {}),
    ...(task.sessions.length > 0 ? { sessions: task.sessions } : {}),
    ...(task.externalRef ? { externalRef: task.externalRef } : {}),
    ...(task.prUrl ? { prUrl: task.prUrl } : {}),
    order: task.order,
    ...(task.doneAt ? { doneAt: task.doneAt } : {}),
    ...(task.archivedAt ? { archivedAt: task.archivedAt } : {}),
    ...(task.questions.length > 0 ? { questions: task.questions } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  })
}

export function parseTaskMarkdown(raw: string, filePath: string): Task {
  const parsed = matter(raw)
  const front = taskFrontmatterSchema.parse(migrateProviderFields(tolerate(parsed.data)))
  const markerAt = parsed.content.indexOf(ACTIVITY_MARKER)
  const headingAt = ACTIVITY_HEADING_RE.exec(parsed.content)?.index ?? -1
  // The marker wins; a bare heading counts only when no marker exists, so a description that
  // mentions "## Activity" above a real marker is left alone.
  const splitAt = markerAt !== -1 ? markerAt : headingAt
  const head = (splitAt === -1 ? parsed.content : parsed.content.slice(0, splitAt)).trim()
  if (splitAt === -1)
    return { ...front, description: head, activity: [], filePath, format: 'markdown' }
  // The section's own lines (the marker, the heading) are not notes.
  const section = parsed.content.slice(splitAt)
  const heading = ACTIVITY_HEADING_RE.exec(section)
  const start = heading
    ? heading.index + heading[0].length
    : section.indexOf('\n') + 1 || section.length
  const { entries, rest } = parseActivity(section.slice(start))
  const description = [head, rest].filter(Boolean).join('\n\n')
  return { ...front, description, activity: entries, filePath, format: 'markdown' }
}
