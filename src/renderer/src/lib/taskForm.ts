import type { TaskDiff } from '@core/diff.js'
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
  ExtraRepo,
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
  /** The other repositories of a worktree task; blank paths are dropped on save. */
  extraRepos: ExtraRepo[]
  orchestrate: boolean
  blockedBy: string[]
  contextFiles: string[]
  promptTemplateId: string
  provider: 'claude' | 'codex'
  /** Empty leaves the model to the prompt template, then to the CLI. */
  model: string
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
    extraRepos: task?.extraRepos ?? [],
    orchestrate: task?.orchestrate ?? settings.taskDefaults.orchestrate,
    blockedBy: task?.blockedBy ?? [],
    contextFiles: task?.contextFiles ?? [],
    promptTemplateId: task?.promptTemplateId ?? '',
    provider: task?.provider ?? settings.defaultProvider,
    model: task?.model ?? '',
    description: task?.description ?? ''
  }
}

/** The form with a preset's values laid over it; an empty preset title keeps what was typed. */
export function withPreset(form: TaskForm, preset: TaskPreset, settings: Settings): TaskForm {
  const fields = presetFields(preset, settings)
  // A model is named for one provider, so it does not survive a preset that switches provider.
  const model = fields.provider === form.provider ? form.model : ''
  return { ...form, ...fields, model, title: fields.title || form.title }
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
    extraRepos: form.extraRepos
      .filter((repo) => repo.repoPath.trim())
      .map((repo) => ({ ...repo, repoPath: repo.repoPath.trim() })),
    orchestrate: form.orchestrate,
    blockedBy: form.blockedBy,
    contextFiles: form.contextFiles,
    promptTemplateId: form.promptTemplateId || undefined,
    provider: form.provider,
    model: form.model.trim() || undefined,
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
 * The model the task would run with when its own Model is left empty: the one the prompt template
 * Start runs names for the task's provider, or undefined for the CLI's default.
 */
export function inheritedModel(
  settings: Settings,
  form: Pick<TaskForm, 'status' | 'readiness' | 'promptTemplateId' | 'provider'>
): string | undefined {
  const { model } = resolveTemplateFor(settings, form)
  return model?.provider === form.provider ? model.name.trim() || undefined : undefined
}

/**
 * The Model dropdown's choices: the models registered for the task's provider, plus the task's own
 * if it is no longer registered (or was written by hand), so the control shows what the file holds.
 */
export function modelOptions(
  settings: Pick<Settings, 'agentModels'>,
  form: Pick<TaskForm, 'provider' | 'model'>
): string[] {
  const registered = settings.agentModels[form.provider]
  return form.model && !registered.includes(form.model) ? [...registered, form.model] : registered
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

/** The hint under "Own git worktree": what running in a worktree means for this form. */
export function worktreeHint(
  form: Pick<TaskForm, 'useWorktree' | 'repoPath'>,
  taskId: string,
  /** The folder's branches have loaded and there are none: it is not a git repository. */
  notARepo: boolean
): string {
  if (!form.useWorktree) return 'Runs directly in the working directory.'
  if (!form.repoPath)
    return 'Set a working directory first — the worktree is created from that repository.'
  if (notARepo)
    return 'This folder does not look like a git repository, so the agent will run in it directly. Turn this off for non-code work.'
  return `Runs on branch styr/${taskId} so parallel agents never share a checkout.`
}

/** The Changes button's tooltip: still loading, nothing to show yet, or ready. */
export function changesTitle(changes: Pick<TaskDiff, 'files' | 'branch'> | null): string {
  if (!changes) return 'Reading changes…'
  if (changes.files.length > 0) return 'View changes'
  return changes.branch ? `No changes on ${changes.branch} yet` : 'No changes to show'
}

/** `current` with `added` appended, skipping paths already attached (picked twice, or dropped
 *  again) and empty ones (a dragged item with no file on disk). */
export function withContextFiles(current: string[], added: string[]): string[] {
  const seen = new Set(current)
  const next = [...current]
  for (const file of added) {
    if (!file || seen.has(file)) continue
    seen.add(file)
    next.push(file)
  }
  return next
}
