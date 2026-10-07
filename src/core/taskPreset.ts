import { MAX_TASK_PRESETS, type Settings, type TaskPreset } from './types.js'

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
