import { MAX_TASK_PRESETS, type Settings, type TaskDraft, type TaskPreset } from './types.js'

/** The task fields a preset covers: what the New task form takes from one. */
export interface PresetFields {
  title: string
  description: string
  tags: string[]
  priority: TaskPreset['priority']
  readiness: TaskPreset['readiness']
  useWorktree: boolean
  orchestrate: boolean
  provider: 'claude' | 'codex'
  promptTemplateId: string
  baseBranch: string
}

/**
 * The form values a preset produces. Optional preset fields fall back to the ordinary defaults,
 * never to whatever was in the form before.
 */
export function presetFields(
  preset: TaskPreset,
  settings: Pick<Settings, 'defaultProvider'>
): PresetFields {
  return {
    title: preset.title,
    description: preset.description,
    tags: [...new Set(preset.tags.map((tag) => tag.trim()).filter(Boolean))],
    priority: preset.priority,
    readiness: preset.readiness,
    useWorktree: preset.useWorktree,
    orchestrate: preset.orchestrate,
    provider: preset.provider ?? settings.defaultProvider,
    promptTemplateId: preset.promptTemplateId ?? '',
    baseBranch: preset.baseBranch ?? ''
  }
}

/** A preset captured from a form. `repoPath`, context files and status are deliberately left out. */
export function presetFromFields(id: string, name: string, fields: PresetFields): TaskPreset {
  return {
    id,
    name: name.trim(),
    title: fields.title.trim(),
    description: fields.description,
    tags: [...new Set(fields.tags.map((tag) => tag.trim()).filter(Boolean))],
    priority: fields.priority,
    readiness: fields.readiness,
    useWorktree: fields.useWorktree,
    orchestrate: fields.orchestrate,
    provider: fields.provider,
    ...(fields.promptTemplateId ? { promptTemplateId: fields.promptTemplateId } : {}),
    ...(fields.baseBranch ? { baseBranch: fields.baseBranch } : {})
  }
}

export function presetNameTaken(
  presets: readonly TaskPreset[],
  name: string,
  exceptId?: string
): boolean {
  const wanted = name.trim().toLowerCase()
  return presets.some(
    (preset) => preset.id !== exceptId && preset.name.trim().toLowerCase() === wanted
  )
}

/** A slug of `name` that no existing id uses. */
export function newPresetId(presets: readonly TaskPreset[], name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'preset'
  const taken = new Set(presets.map((preset) => preset.id))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

export function canAddPreset(presets: readonly TaskPreset[]): boolean {
  return presets.length < MAX_TASK_PRESETS
}

/** Whether the form still holds exactly what applying `preset` put there. */
export function matchesPreset(
  fields: PresetFields,
  preset: TaskPreset,
  settings: Pick<Settings, 'defaultProvider'>
): boolean {
  return JSON.stringify(fields) === JSON.stringify(presetFields(preset, settings))
}

/**
 * Whether the Quick add input is asking for the preset picker, and for what. It is only the first
 * token: a `/` later in a title (a path, `a/b`) is plain text.
 */
export function parseSlashQuery(value: string): string | null {
  const match = /^\/(\S*)$/.exec(value)
  return match ? match[1]! : null
}

/** Presets whose name contains `query`, name-prefix matches first, otherwise in preset order. */
export function filterPresets(presets: readonly TaskPreset[], query: string): TaskPreset[] {
  const wanted = query.trim().toLowerCase()
  const hits = presets.filter((preset) => preset.name.toLowerCase().includes(wanted))
  const starts = hits.filter((preset) => preset.name.toLowerCase().startsWith(wanted))
  return [...starts, ...hits.filter((preset) => !starts.includes(preset))]
}

/**
 * `/bug fix ui`: a leading `/name ` that matches exactly one preset by name, so the tag can be
 * applied from the keyboard without the picker. Null when it is ambiguous or matches nothing.
 */
export function leadingPreset(
  presets: readonly TaskPreset[],
  value: string
): { preset: TaskPreset; rest: string } | null {
  const match = /^\/(\S+)\s(.*)$/s.exec(value)
  if (!match) return null
  const name = match[1]!.toLowerCase()
  const exact = presets.filter((preset) => preset.name.trim().toLowerCase() === name)
  return exact.length === 1 ? { preset: exact[0]!, rest: match[2]! } : null
}

type QuickDefaults = Pick<Settings, 'defaultRepoPath' | 'defaultProvider' | 'taskDefaults'>

/**
 * The task a Quick add creates. Without a preset it is the plain capture (Needs spec); with one,
 * the preset supplies everything but the title, which is what was typed.
 */
export function quickTaskDraft(
  preset: TaskPreset | undefined,
  title: string,
  settings: QuickDefaults
): TaskDraft | null {
  const typed = title.trim()
  const repoPath = settings.defaultRepoPath.trim() || undefined
  if (!preset) {
    if (!typed) return null
    return {
      title: typed,
      status: 'backlog',
      priority: 'medium',
      readiness: 'needs_spec',
      tags: [],
      repoPath,
      useWorktree: settings.taskDefaults.useWorktree,
      orchestrate: settings.taskDefaults.orchestrate,
      contextFiles: [],
      provider: settings.defaultProvider,
      description: ''
    }
  }
  const fields = presetFields(preset, settings)
  const finalTitle = typed || fields.title.trim()
  if (!finalTitle) return null
  return {
    title: finalTitle,
    status: 'backlog',
    priority: fields.priority,
    readiness: fields.readiness,
    tags: fields.tags,
    repoPath,
    useWorktree: fields.useWorktree,
    orchestrate: fields.orchestrate,
    contextFiles: [],
    provider: fields.provider,
    description: fields.description,
    ...(fields.promptTemplateId ? { promptTemplateId: fields.promptTemplateId } : {}),
    ...(fields.baseBranch ? { baseBranch: fields.baseBranch } : {})
  }
}
