import { describe, expect, it } from 'vitest'
import { settingsSchema } from './taskSchema.js'
import {
  canAddPreset,
  matchesPreset,
  newPresetId,
  presetFields,
  presetFromFields,
  presetNameTaken
} from './taskPreset.js'
import { DEFAULT_TASK_PRESETS, MAX_TASK_PRESETS, type TaskPreset } from './types.js'
import { shippedSettings } from './config.js'

const bug = DEFAULT_TASK_PRESETS[0]!
const defaults = { defaultProvider: 'codex' as const }

describe('presetFields', () => {
  it('copies the preset and falls back to defaults for unset options', () => {
    const fields = presetFields(bug, defaults)
    expect(fields).toMatchObject({ priority: 'high', tags: ['bug'], provider: 'codex' })
    expect(fields.promptTemplateId).toBe('')
    expect(fields.baseBranch).toBe('')
  })

  it('uses the preset provider when set and dedupes tags', () => {
    const fields = presetFields({ ...bug, provider: 'claude', tags: ['a', ' a ', ''] }, defaults)
    expect(fields.provider).toBe('claude')
    expect(fields.tags).toEqual(['a'])
  })
})

describe('presetFromFields', () => {
  it('round-trips through presetFields', () => {
    const fields = presetFields(bug, defaults)
    const made = presetFromFields('x', ' Mine ', { ...fields, baseBranch: 'dev' })
    expect(made).toMatchObject({ id: 'x', name: 'Mine', baseBranch: 'dev' })
    expect(matchesPreset(presetFields(made, defaults), made, defaults)).toBe(true)
  })
})

describe('names and ids', () => {
  const presets: TaskPreset[] = [bug]
  it('detects duplicate names case-insensitively, except for the edited one', () => {
    expect(presetNameTaken(presets, ' BUG ')).toBe(true)
    expect(presetNameTaken(presets, 'bug', 'bug')).toBe(false)
    expect(presetNameTaken(presets, 'Chore')).toBe(false)
  })
  it('generates unique slugs', () => {
    expect(newPresetId(presets, 'Chore!')).toBe('chore')
    expect(newPresetId(presets, 'Bug')).toBe('bug-2')
    expect(newPresetId([], '!!!')).toBe('preset')
  })
  it('caps the list', () => {
    const full = Array.from({ length: MAX_TASK_PRESETS }, (_, i) => ({ ...bug, id: `p${i}` }))
    expect(canAddPreset(full)).toBe(false)
    expect(canAddPreset(presets)).toBe(true)
  })
})

describe('taskPresets setting', () => {
  it('ships the default presets and drops one bad entry without losing the rest', () => {
    expect(shippedSettings().taskPresets.map((p) => p.id)).toEqual([
      'bug',
      'spec',
      'refactor',
      'research',
      'writing'
    ])
    const parsed = settingsSchema.parse({
      ...shippedSettings(),
      taskPresets: [bug, { id: 'broken' }, { ...bug, id: 'ok', name: 'Ok' }]
    })
    expect(parsed.taskPresets.map((p) => p.id)).toEqual(['bug', 'ok'])
  })
})
