import { danglingBlockers, findCycle, indexTasks } from '@core/blocking.js'
import { resolveTemplateFor } from '@core/prompt.js'
import {
  canAddPreset,
  matchesPreset,
  newPresetId,
  presetFields,
  presetFromFields
} from '@core/taskPreset.js'
import type {
  Settings,
  Task,
  TaskPreset,
  TaskPriority,
  TaskReadiness,
  TaskStatus
} from '@core/types.js'
import { fileName } from './terminalPath.js'

/** The task dialog's fields, as typed: trimmed and defaulted only by `taskPayload`. */
export interface TaskForm {
  title: string
  status: TaskStatus
  priority: TaskPriority
  readiness: TaskReadiness
  project: string
  tags: string[]
  repoPath: string
  prUrl: string
  useWorktree: boolean
  baseBranch: string
  orchestrate: boolean
  blockedBy: string[]
  contextFiles: string[]
  promptTemplateId: string
  provider: 'claude' | 'codex'
  description: string
}

/** The form for a task, or for a new one seeded from the workspace's defaults. */
export function toForm(task: Task | null, settings: Settings): TaskForm {
  return {
    title: task?.title ?? '',
    status: task?.status ?? 'backlog',
    priority: task?.priority ?? 'medium',
    readiness: task?.readiness ?? 'ready',
    project: task?.project ?? '',
    tags: task?.tags ?? [],
    repoPath: task?.repoPath ?? settings.defaultRepoPath,
    prUrl: task?.prUrl ?? '',
    useWorktree: task?.useWorktree ?? settings.taskDefaults.useWorktree,
    baseBranch: task?.baseBranch ?? '',
    orchestrate: task?.orchestrate ?? settings.taskDefaults.orchestrate,
    blockedBy: task?.blockedBy ?? [],
    contextFiles: task?.contextFiles ?? [],
    promptTemplateId: task?.promptTemplateId ?? '',
    provider: task?.provider ?? settings.defaultProvider,
    description: task?.description ?? ''
  }
}

/** The form with a preset's values laid over it; an empty preset title keeps what was typed. */
export function withPreset(form: TaskForm, preset: TaskPreset, settings: Settings): TaskForm {
  const fields = presetFields(preset, settings)
  return { ...form, ...fields, title: fields.title || form.title }
}

function formPresetFields(form: TaskForm): ReturnType<typeof presetFields> {
  return {
    title: form.title,
    description: form.description,
    tags: form.tags,
    priority: form.priority,
    readiness: form.readiness,
    useWorktree: form.useWorktree,
    orchestrate: form.orchestrate,
    provider: form.provider,
    promptTemplateId: form.promptTemplateId,
    baseBranch: form.baseBranch
  }
}

/** The form to start a new task with: the defaults, with the preset it was opened from laid over. */
export function initialForm(task: Task | null, settings: Settings, preset?: TaskPreset): TaskForm {
  const base = toForm(task, settings)
  return preset ? withPreset(base, preset, settings) : base
}

/**
 * Picking a preset in the dialog (`''` is None). Laying one over typed work needs a confirm; going
 * back to None clears only what the previous preset put there, keeping the chosen folder.
 */
export function choosePreset(
  form: TaskForm,
  appliedPresetId: string,
  nextId: string,
  settings: Settings
): { form: TaskForm | null; presetId: string; confirm: boolean } {
  const previous = settings.taskPresets.find((p) => p.id === appliedPresetId)
  const untouched = previous
    ? matchesPreset(formPresetFields(form), previous, settings)
    : !form.title.trim() && !form.description.trim()
  const next = settings.taskPresets.find((p) => p.id === nextId)
  if (!next) {
    const cleared =
      previous && untouched ? toForm(null, { ...settings, defaultRepoPath: form.repoPath }) : null
    return { form: cleared, presetId: '', confirm: false }
  }
  const typed = Boolean(form.title.trim() || form.description.trim()) && !untouched
  return { form: withPreset(form, next, settings), presetId: next.id, confirm: typed }
}

/**
 * Saving the form as a preset named `name`: a name already in use (any case) replaces that preset
 * after a confirm, a new one needs room under the cap.
 */
export function savePresetPlan(
  presets: TaskPreset[],
  name: string,
  form: TaskForm
):
  | { kind: 'empty' }
  | { kind: 'full' }
  | { kind: 'save'; presets: TaskPreset[]; presetId: string; replaces?: TaskPreset } {
  const trimmed = name.trim()
  if (!trimmed) return { kind: 'empty' }
  const existing = presets.find((p) => p.name.trim().toLowerCase() === trimmed.toLowerCase())
  if (!existing && !canAddPreset(presets)) return { kind: 'full' }
  const made = presetFromFields(
    existing?.id ?? newPresetId(presets, trimmed),
    trimmed,
    formPresetFields(form)
  )
  return {
    kind: 'save',
    presetId: made.id,
    replaces: existing,
    presets: existing ? presets.map((p) => (p.id === existing.id ? made : p)) : [...presets, made]
  }
}

/** What the form saves: trimmed, with blanks left unset and the project defaulting to the folder. */
export function taskPayload(form: TaskForm) {
  return {
    title: form.title.trim(),
    status: form.status,
    priority: form.priority,
    readiness: form.readiness,
    project: form.project.trim() || fileName(form.repoPath.trim()) || undefined,
    tags: form.tags,
    repoPath: form.repoPath.trim() || undefined,
    prUrl: form.prUrl.trim() || undefined,
    useWorktree: form.useWorktree,
    baseBranch: form.baseBranch || undefined,
    orchestrate: form.orchestrate,
    blockedBy: form.blockedBy,
    contextFiles: form.contextFiles,
    promptTemplateId: form.promptTemplateId || undefined,
    provider: form.provider,
    description: form.description
  }
}

/** The template the column routes to, and the one Start runs: the pinned one while it exists. */
export function templateNames(
  settings: Settings,
  form: Pick<TaskForm, 'status' | 'readiness' | 'promptTemplateId'>
): { routed: string; effective: string } {
  const routed = resolveTemplateFor(settings, {
    status: form.status,
    readiness: form.readiness
  }).name
  const pinned = form.promptTemplateId
    ? settings.promptTemplates.find((template) => template.id === form.promptTemplateId)
    : undefined
  return { routed, effective: pinned?.name ?? routed }
}

/**
 * The Blocked by row: ids that match no task, a cycle the current list already makes, and the
 * tasks that could still be added — open, not archived, not this task, each flagged when adding it
 * would close a cycle. A new task has no id yet, so it can be in no cycle.
 */
export function blockerState(
  taskId: string | undefined,
  blockedBy: string[],
  allTasks: Task[]
): {
  missing: string[]
  cycle: string[] | null
  choices: { id: string; title: string; cycle: boolean }[]
} {
  const lookup = indexTasks(allTasks)
  return {
    missing: danglingBlockers({ blockedBy }, lookup),
    cycle: taskId ? findCycle(taskId, blockedBy, lookup) : null,
    choices: allTasks
      .filter(
        (other) =>
          other.id !== taskId &&
          !other.archivedAt &&
          other.status !== 'done' &&
          !blockedBy.includes(other.id)
      )
      .map((other) => ({
        id: other.id,
        title: other.title,
        cycle: taskId ? findCycle(taskId, [other.id], lookup) !== null : false
      }))
  }
}
