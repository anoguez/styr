import { resolveTemplateFor } from './prompt.js'
import type { Settings, Task } from './types.js'

/**
 * Whether a task's current chat is a spec run that has handed the task back: Backlog, ready, and
 * `agentSession` pointing at a `Task.sessions` entry that ran the template `needs_spec` routes to
 * (its recorded `templateId`; older entries: their `label`). The next run is an implement run, and
 * it must not continue the spec chat, so the pointer is cleared (the history stays).
 *
 * Never true when a pinned template runs both lanes, since the two runs cannot then be told apart,
 * nor when the pointer names a chat missing from `sessions`, which cannot be proven a spec run.
 */
export function isSpecHandoff(settings: Settings, task: Task): boolean {
  if (task.status !== 'backlog' || task.readiness !== 'ready') return false
  const pointer = task.agentSession
  const current = pointer && task.sessions.find((entry) => entry.id === pointer.id)
  if (!current) return false
  const spec = resolveTemplateFor(settings, { ...task, status: 'backlog', readiness: 'needs_spec' })
  const implement = resolveTemplateFor(settings, { ...task, status: 'backlog', readiness: 'ready' })
  if (spec.id === implement.id) return false
  return current.templateId !== undefined
    ? current.templateId === spec.id
    : current.label === spec.name
}
