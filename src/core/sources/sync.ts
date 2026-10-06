import { createHash } from 'node:crypto'
import type { ExternalRef, RemoteItem, SourceConfig, Task, TaskDraft, TaskPatch } from '../types.js'

/** The first import never pulls more than this many issues. */
export const IMPORT_LIMIT = 200

export function contentHash(title: string, body: string): string {
  return createHash('sha1').update(`${title}\n${body}`).digest('hex').slice(0, 16)
}

export type SyncAction =
  | { kind: 'create'; draft: TaskDraft }
  | { kind: 'update'; taskId: string; patch: TaskPatch; note?: string }
  | { kind: 'note'; taskId: string; note: string }

export interface SyncPlan {
  actions: SyncAction[]
  created: number
  updated: number
  unchanged: number
}

function refFor(source: SourceConfig, item: RemoteItem, hash: string): ExternalRef {
  return {
    provider: source.provider,
    id: item.id,
    url: item.url,
    sourceId: source.id,
    remoteUpdatedAt: item.updatedAt,
    syncedHash: hash
  }
}

function tagsFor(prefix: string, item: RemoteItem): string[] {
  return item.labels.map((label) => `${prefix}:${label}`)
}

/** Replaces the tags that came from the source, keeping the ones the user added. */
function mergeTags(current: string[], prefix: string, item: RemoteItem): string[] {
  const own = `${prefix}:`
  return [...current.filter((tag) => !tag.startsWith(own)), ...tagsFor(prefix, item)]
}

export function linkedTask(tasks: Task[], sourceId: string, itemId: string): Task | undefined {
  return tasks.find(
    (task) => task.externalRef?.sourceId === sourceId && task.externalRef.id === itemId
  )
}

/**
 * Decides what a sync does, without doing it. New issues become Backlog / needs-spec tasks; a
 * linked task takes the remote title, body and labels only if the user has not edited them
 * since the last import; a remote close moves it to Done unless it is mid-work.
 */
export function planSync(
  tasks: Task[],
  items: RemoteItem[],
  source: SourceConfig,
  tagPrefix: string
): SyncPlan {
  const plan: SyncPlan = { actions: [], created: 0, updated: 0, unchanged: 0 }

  for (const item of items) {
    const task = linkedTask(tasks, source.id, item.id)

    if (!task) {
      if (item.state === 'closed' && !source.includeClosed) continue
      plan.actions.push({
        kind: 'create',
        draft: {
          title: item.title,
          description: item.body,
          status: item.state === 'closed' ? 'done' : 'backlog',
          readiness: 'needs_spec',
          tags: tagsFor(tagPrefix, item),
          externalRef: refFor(source, item, contentHash(item.title, item.body))
        }
      })
      plan.created++
      continue
    }

    const ref = task.externalRef!
    if (ref.remoteUpdatedAt === item.updatedAt) {
      plan.unchanged++
      continue
    }

    const patch: TaskPatch = {}
    const notes: string[] = []
    const edited =
      ref.syncedHash !== undefined && ref.syncedHash !== contentHash(task.title, task.description)
    let hash = ref.syncedHash

    if (edited) {
      notes.push(
        `${source.name || source.repo} #${item.id} changed remotely; your edited title and description were kept.`
      )
    } else {
      patch.title = item.title
      patch.description = item.body
      hash = contentHash(item.title, item.body)
    }
    patch.tags = mergeTags(task.tags, tagPrefix, item)

    if (item.state === 'closed' && task.status !== 'done' && !task.archivedAt) {
      if (task.status === 'in_progress') {
        notes.push(`#${item.id} was closed on ${source.name || source.provider}; left in progress.`)
      } else {
        patch.status = 'done'
        notes.push(`#${item.id} was closed on ${source.name || source.provider}.`)
      }
    }

    patch.externalRef = {
      ...ref,
      url: item.url,
      remoteUpdatedAt: item.updatedAt,
      ...(hash ? { syncedHash: hash } : {})
    }
    plan.actions.push({
      kind: 'update',
      taskId: task.id,
      patch,
      ...(notes.length ? { note: notes.join(' ') } : {})
    })
    plan.updated++
  }
  return plan
}

export type PushAction =
  | { kind: 'close'; itemId: string; note: string }
  | { kind: 'reopen'; itemId: string; note: string }
  | { kind: 'comment'; itemId: string; body: string; note: string }

/**
 * What a status change should do remotely. Pure and permission-blind: whether the source may be
 * written is decided by `writableSource`, not here.
 */
export function planPush(before: Task, after: Task, source: SourceConfig): PushAction[] {
  const ref = after.externalRef
  if (!ref || ref.sourceId !== source.id || before.status === after.status) return []
  const actions: PushAction[] = []
  if (source.mirrorStatus) {
    if (after.status === 'done') {
      actions.push({
        kind: 'close',
        itemId: ref.id,
        note: `Closed #${ref.id} on ${source.name || source.provider}.`
      })
    } else if (before.status === 'done') {
      actions.push({
        kind: 'reopen',
        itemId: ref.id,
        note: `Reopened #${ref.id} on ${source.name || source.provider}.`
      })
    }
  }
  if (source.commentOnReview && after.status === 'in_review' && after.prUrl) {
    actions.push({
      kind: 'comment',
      itemId: ref.id,
      body: `Ready for review in Styr (${after.id}): ${after.prUrl}`,
      note: `Commented on #${ref.id} on ${source.name || source.provider}.`
    })
  }
  return actions
}
