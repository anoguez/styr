import { createHash } from 'node:crypto'
import type {
  ExternalRef,
  RemoteItem,
  SourceConfig,
  SourceTarget,
  Task,
  TaskDraft,
  TaskPatch
} from '../types.js'

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

export function fieldHashes(
  title: string,
  body: string
): Pick<ExternalRef, 'syncedHash' | 'syncedTitleHash' | 'syncedBodyHash'> {
  return {
    syncedHash: contentHash(title, body),
    syncedTitleHash: contentHash(title, ''),
    syncedBodyHash: contentHash('', body)
  }
}

/** Has the user changed this field since the last import? Older links carry only the combined hash. */
function editedLocally(ref: ExternalRef, task: Task): { title: boolean; body: boolean } {
  if (ref.syncedTitleHash !== undefined || ref.syncedBodyHash !== undefined) {
    return {
      title:
        ref.syncedTitleHash !== undefined && ref.syncedTitleHash !== contentHash(task.title, ''),
      body:
        ref.syncedBodyHash !== undefined && ref.syncedBodyHash !== contentHash('', task.description)
    }
  }
  const both =
    ref.syncedHash !== undefined && ref.syncedHash !== contentHash(task.title, task.description)
  return { title: both, body: both }
}

function refFor(source: SourceConfig, target: string, item: RemoteItem): ExternalRef {
  return {
    provider: source.provider,
    id: item.id,
    url: item.url,
    sourceId: source.id,
    target,
    remoteUpdatedAt: item.updatedAt,
    ...fieldHashes(item.title, item.body)
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

/** Item ids repeat across repositories, so a link is the source, the repository and the id. */
export function linkedTask(
  tasks: Task[],
  sourceId: string,
  target: string,
  itemId: string
): Task | undefined {
  return tasks.find(
    (task) =>
      task.externalRef?.sourceId === sourceId &&
      task.externalRef.target === target &&
      task.externalRef.id === itemId
  )
}

/**
 * Decides what a sync does, without doing it. New issues become Backlog / ready tasks; a
 * linked task takes the remote title, body and labels only if the user has not edited them
 * since the last import; a remote close moves it to Done unless it is mid-work.
 */
export function planSync(
  tasks: Task[],
  items: RemoteItem[],
  source: SourceConfig,
  tagPrefix: string,
  where: SourceTarget,
  defaults: { useWorktree?: boolean; orchestrate?: boolean } = {}
): SyncPlan {
  const { target } = where
  const plan: SyncPlan = { actions: [], created: 0, updated: 0, unchanged: 0 }

  for (const item of items) {
    const task = linkedTask(tasks, source.id, target, item.id)

    if (!task) {
      if (item.state === 'closed' && !source.includeClosed) continue
      plan.actions.push({
        kind: 'create',
        draft: {
          title: item.title,
          description: item.body,
          status: item.state === 'closed' ? 'done' : 'backlog',
          readiness: 'ready',
          ...(defaults.useWorktree !== undefined ? { useWorktree: defaults.useWorktree } : {}),
          ...(defaults.orchestrate !== undefined ? { orchestrate: defaults.orchestrate } : {}),
          tags: tagsFor(tagPrefix, item),
          repoPath: where.repoPath,
          externalRef: refFor(source, target, item)
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
    const edited = editedLocally(ref, task)
    let titleHash = ref.syncedTitleHash
    let bodyHash = ref.syncedBodyHash
    if (edited.title) {
      notes.push(`${target}#${item.id} changed remotely; your edited title was kept.`)
    } else {
      patch.title = item.title
      titleHash = contentHash(item.title, '')
    }
    if (edited.body) {
      notes.push(`${target}#${item.id} changed remotely; your edited description was kept.`)
    } else {
      patch.description = item.body
      bodyHash = contentHash('', item.body)
    }
    const hash = contentHash(patch.title ?? task.title, patch.description ?? task.description)
    patch.tags = mergeTags(task.tags, tagPrefix, item)

    if (item.state === 'closed' && task.status !== 'done' && !task.archivedAt) {
      if (task.status === 'in_progress') {
        notes.push(`${target}#${item.id} was closed remotely; left in progress.`)
      } else {
        patch.status = 'done'
        notes.push(`${target}#${item.id} was closed remotely.`)
      }
    }

    patch.externalRef = {
      ...ref,
      url: item.url,
      remoteUpdatedAt: item.updatedAt,
      syncedHash: hash,
      ...(titleHash ? { syncedTitleHash: titleHash } : {}),
      ...(bodyHash ? { syncedBodyHash: bodyHash } : {})
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
  if (!ref?.target || ref.sourceId !== source.id || before.status === after.status) return []
  const actions: PushAction[] = []
  if (source.mirrorStatus) {
    if (after.status === 'done') {
      actions.push({
        kind: 'close',
        itemId: ref.id,
        note: `Closed ${ref.target}#${ref.id} on ${source.provider}.`
      })
    } else if (before.status === 'done') {
      actions.push({
        kind: 'reopen',
        itemId: ref.id,
        note: `Reopened ${ref.target}#${ref.id} on ${source.provider}.`
      })
    }
  }
  if (source.commentOnReview && after.status === 'in_review' && after.prUrl) {
    actions.push({
      kind: 'comment',
      itemId: ref.id,
      body: `Ready for review in Styr (${after.id}): ${after.prUrl}`,
      note: `Commented on ${ref.target}#${ref.id} on ${source.provider}.`
    })
  }
  return actions
}

export interface BlockerUpdate {
  taskId: string
  blockedBy: string[]
  note: string
}

/**
 * Mirrors the source's "blocked by" relations onto linked tasks. A separate pass after the tasks
 * exist, since a blocker may be imported in the same sync. Only adds: a blocker the user set
 * locally is never removed, and a blocker with no task here (never imported, other repository) is
 * skipped. An item with unknown relations (`blockedBy` undefined) changes nothing.
 */
export function planBlockers(
  tasks: Task[],
  items: RemoteItem[],
  source: SourceConfig,
  target: string
): BlockerUpdate[] {
  const updates: BlockerUpdate[] = []
  for (const item of items) {
    if (!item.blockedBy?.length) continue
    const task = linkedTask(tasks, source.id, target, item.id)
    if (!task || task.archivedAt) continue
    const added: string[] = []
    for (const blocker of item.blockedBy) {
      const other = linkedTask(tasks, source.id, blocker.target, blocker.id)
      if (!other || other.id === task.id || task.blockedBy.includes(other.id)) continue
      added.push(other.id)
    }
    if (added.length === 0) continue
    updates.push({
      taskId: task.id,
      blockedBy: [...task.blockedBy, ...added],
      note: `${target}#${item.id} is blocked by ${added.join(', ')} on ${source.provider}.`
    })
  }
  return updates
}
