// `split_task`: break a task into children and turn it into their blocked umbrella. Everything
// is written through the store; the parent is touched only after every child exists.
import { getSection, setSection } from './sections.js'
import { addNote, createTask, deleteTask, getTask, listTasks, updateTask } from './taskStore.js'
import { findCycle, indexTasks } from './blocking.js'
import type { Task, TaskPriority, TaskReadiness } from './types.js'

export const SPLIT_HEADING = 'Split into'
export const MAX_SPLIT_CHILDREN = 20

export interface SplitChild {
  title: string
  description?: string
  priority?: TaskPriority
  tags?: string[]
  readiness?: TaskReadiness
  /** 0-based indexes of earlier siblings in the same call. */
  after?: number[]
  /** Ids of existing tasks. */
  blockedBy?: string[]
}

export interface SplitResult {
  parent: Task
  children: Task[]
}

/** Every reason the split cannot be made, before anything is written. */
function problems(parent: Task | null, id: string, children: SplitChild[], all: Task[]): string[] {
  if (!parent) return [`Task ${id} not found`]
  const found: string[] = []
  if (parent.status === 'done') found.push(`${id} is Done and cannot be split`)
  if (parent.archivedAt) found.push(`${id} is archived and cannot be split`)
  if (children.length < 1 || children.length > MAX_SPLIT_CHILDREN)
    found.push(`Split into 1 to ${MAX_SPLIT_CHILDREN} children, not ${children.length}`)
  const byId = indexTasks(all)
  for (const [index, child] of children.entries()) {
    if (!child.title.trim()) found.push(`Child ${index} needs a title`)
    for (const earlier of child.after ?? []) {
      if (!Number.isInteger(earlier) || earlier < 0 || earlier >= index)
        found.push(`Child ${index}: after ${earlier} must be the index of an earlier child`)
    }
    for (const blocker of child.blockedBy ?? []) {
      if (!byId.has(blocker)) found.push(`Child ${index}: blockedBy ${blocker} is not a task`)
    }
  }
  // A child blocked by something that waits on the parent would make the parent wait on itself.
  const external = [...new Set(children.flatMap((child) => child.blockedBy ?? []))]
  const cycle = findCycle(id, external, byId)
  if (cycle)
    found.push(
      `A child cannot be blocked by ${cycle.slice(1, -1).join(' → ')}: ${id} waits on the children`
    )
  return found
}

function splitSection(existing: string | undefined, added: Task[]): string {
  const lines = (existing ?? '').split('\n').filter((line) => line.trim().startsWith('- '))
  const known = new Set(lines.map((line) => /TASK-\d+/.exec(line)?.[0]))
  for (const child of added) if (!known.has(child.id)) lines.push(`- ${child.id} — ${child.title}`)
  return lines.join('\n')
}

export function splitTask(id: string, children: SplitChild[], author: string): SplitResult {
  const all = listTasks()
  const parent = all.find((task) => task.id === id) ?? null
  const bad = problems(parent, id, children, all)
  if (bad.length > 0 || !parent) throw new Error(bad.join('; '))

  const created: Task[] = []
  try {
    for (const [index, child] of children.entries()) {
      const heading = `Part ${index + 1}/${children.length} of ${id}: ${parent.title}.`
      created.push(
        createTask({
          title: child.title.trim(),
          description: [heading, child.description?.trim()].filter(Boolean).join('\n\n'),
          status: 'backlog',
          priority: child.priority,
          tags: child.tags,
          readiness: child.readiness ?? 'ready',
          project: parent.project,
          repoPath: parent.repoPath,
          useWorktree: parent.useWorktree,
          baseBranch: parent.baseBranch,
          provider: parent.provider,
          model: parent.model,
          contextFiles: [...parent.contextFiles],
          orchestrate: parent.orchestrate,
          blockedBy: [
            ...new Set([
              ...(child.blockedBy ?? []),
              ...(child.after ?? []).map((earlier) => (created[earlier] as Task).id)
            ])
          ]
        })
      )
    }
  } catch (error) {
    for (const made of created) deleteTask(made.id)
    throw error
  }

  const current = getTask(id) as Task
  const description = setSection(
    current.description,
    SPLIT_HEADING,
    splitSection(getSection(current.description, SPLIT_HEADING), created)
  )
  updateTask(id, {
    blockedBy: [...new Set([...current.blockedBy, ...created.map((child) => child.id)])],
    orchestrate: false,
    description
  })
  const ids = created.map((child) => child.id)
  const saved = addNote(id, author, `Split into ${ids.join(', ')}`)
  const notes = created.map((child) => addNote(child.id, author, `Split from ${id}`))
  return { parent: saved, children: notes }
}
