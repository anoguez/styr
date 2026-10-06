import { useState, type ReactNode } from 'react'
import {
  MAX_TASK_PRESETS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_READINESS,
  TASK_READINESS_LABELS,
  type Settings,
  type TaskPreset
} from '@core/types.js'
import { canAddPreset, newPresetId, presetNameTaken } from '@core/taskPreset.js'
import { Button, Card, CardRow, Field, Hint, Select, SwitchRow, inputClass } from './ui.js'

const BLANK: Omit<TaskPreset, 'id' | 'name'> = {
  title: '',
  description: '',
  tags: [],
  priority: 'medium',
  readiness: 'ready',
  useWorktree: false,
  orchestrate: true
}

/** Settings → Presets: the workspace's starting points for the New task dialog. */
export function PresetsPane({
  presets,
  settings,
  onChange
}: {
  presets: TaskPreset[]
  settings: Settings
  onChange: (presets: TaskPreset[]) => void
}): ReactNode {
  const [selectedId, setSelectedId] = useState<string | null>(presets[0]?.id ?? null)
  const selected = presets.find((preset) => preset.id === selectedId) ?? null
  const [tagsText, setTagsText] = useState<{ id: string; text: string } | null>(null)

  const update = (id: string, changes: Partial<TaskPreset>): void =>
    onChange(presets.map((preset) => (preset.id === id ? { ...preset, ...changes } : preset)))

  function add(): void {
    let name = 'New preset'
    for (let n = 2; presetNameTaken(presets, name); n++) name = `New preset ${n}`
    const preset: TaskPreset = { id: newPresetId(presets, name), name, ...BLANK }
    onChange([...presets, preset])
    setSelectedId(preset.id)
  }

  function duplicate(source: TaskPreset): void {
    let name = `${source.name} copy`
    for (let n = 2; presetNameTaken(presets, name); n++) name = `${source.name} copy ${n}`
    const copy: TaskPreset = { ...source, id: newPresetId(presets, name), name }
    onChange([...presets, copy])
    setSelectedId(copy.id)
  }

  function remove(id: string): void {
    const next = presets.filter((preset) => preset.id !== id)
    onChange(next)
    setSelectedId(next[0]?.id ?? null)
  }

  function move(id: string, by: -1 | 1): void {
    const index = presets.findIndex((preset) => preset.id === id)
    const target = index + by
    if (index < 0 || target < 0 || target >= presets.length) return
    const next = [...presets]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    onChange(next)
  }

  const nameClash = selected ? presetNameTaken(presets, selected.name, selected.id) : false
  const nameEmpty = selected ? selected.name.trim() === '' : false

  return (
    <div className="flex flex-col gap-4">
      <Card>
        {presets.length === 0 ? (
          <CardRow>
            <p className="px-3.5 py-3 text-[12.5px] text-dim">
              No presets. The New task dialog starts blank.
            </p>
          </CardRow>
        ) : null}
        {presets.map((preset, index) => (
          <CardRow key={preset.id}>
            <div
              className={`flex items-center gap-2 px-3.5 py-2 ${preset.id === selectedId ? 'bg-raised/60' : ''}`}
            >
              <button
                type="button"
                onClick={() => setSelectedId(preset.id)}
                className="min-w-0 flex-1 truncate text-left text-[12.5px] text-ink"
              >
                {preset.name || 'Untitled'}
              </button>
              <Button
                variant="subtle"
                aria-label={`Move ${preset.name} up`}
                disabled={index === 0}
                onClick={() => move(preset.id, -1)}
              >
                ↑
              </Button>
              <Button
                variant="subtle"
                aria-label={`Move ${preset.name} down`}
                disabled={index === presets.length - 1}
                onClick={() => move(preset.id, 1)}
              >
                ↓
              </Button>
            </div>
          </CardRow>
        ))}
      </Card>
      <div className="flex items-center gap-2">
        <Button onClick={add} disabled={!canAddPreset(presets)}>
          Add preset
        </Button>
        {selected ? (
          <>
            <Button onClick={() => duplicate(selected)} disabled={!canAddPreset(presets)}>
              Duplicate
            </Button>
            <Button onClick={() => remove(selected.id)}>Delete</Button>
          </>
        ) : null}
        {!canAddPreset(presets) ? <Hint>At most {MAX_TASK_PRESETS} presets.</Hint> : null}
      </div>

      {selected ? (
        <div className="flex flex-col gap-3.5">
          <Field label="Name">
            <input
              aria-label="Preset name"
              aria-invalid={nameClash || nameEmpty}
              value={selected.name}
              onChange={(event) => update(selected.id, { name: event.target.value })}
              // Saving needs a unique, non-empty name, so leaving the field settles it.
              onBlur={() => {
                if (!nameClash && !nameEmpty) return
                const base = nameEmpty ? 'Untitled' : selected.name.trim()
                let name = base
                for (let n = 2; presetNameTaken(presets, name, selected.id); n++) {
                  name = `${base} ${n}`
                }
                update(selected.id, { name })
              }}
              className={inputClass}
            />
            {nameClash || nameEmpty ? (
              <span role="alert" className="text-[11.5px] text-danger">
                {nameEmpty ? 'A name is required.' : 'Another preset already has this name.'}
              </span>
            ) : null}
          </Field>
          <Field label="Title" hint="Leave empty to type it each time.">
            <input
              aria-label="Preset title"
              value={selected.title}
              onChange={(event) => update(selected.id, { title: event.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Description">
            <textarea
              aria-label="Preset description"
              value={selected.description}
              rows={5}
              onChange={(event) => update(selected.id, { description: event.target.value })}
              className={`${inputClass} font-mono text-[12px]`}
            />
          </Field>
          <Field label="Tags" hint="Comma separated.">
            <input
              aria-label="Preset tags"
              value={tagsText?.id === selected.id ? tagsText.text : selected.tags.join(', ')}
              onChange={(event) => {
                setTagsText({ id: selected.id, text: event.target.value })
                update(selected.id, {
                  tags: [
                    ...new Set(
                      event.target.value
                        .split(',')
                        .map((tag) => tag.trim())
                        .filter(Boolean)
                    )
                  ]
                })
              }}
              onBlur={() => setTagsText(null)}
              className={inputClass}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Priority">
              <Select
                aria-label="Preset priority"
                value={selected.priority}
                onChange={(event) =>
                  update(selected.id, { priority: event.target.value as TaskPreset['priority'] })
                }
              >
                {TASK_PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {TASK_PRIORITY_LABELS[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Readiness">
              <Select
                aria-label="Preset readiness"
                value={selected.readiness}
                onChange={(event) =>
                  update(selected.id, { readiness: event.target.value as TaskPreset['readiness'] })
                }
              >
                {TASK_READINESS.map((value) => (
                  <option key={value} value={value}>
                    {TASK_READINESS_LABELS[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Agent">
              <Select
                aria-label="Preset agent"
                value={selected.provider ?? ''}
                onChange={(event) =>
                  update(selected.id, {
                    provider: (event.target.value || undefined) as TaskPreset['provider']
                  })
                }
              >
                <option value="">Workspace default</option>
                {settings.enabledProviders.map((provider) => (
                  <option key={provider} value={provider}>
                    {provider === 'codex' ? 'Codex' : 'Claude Code'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Prompt template">
              <Select
                aria-label="Preset prompt template"
                value={selected.promptTemplateId ?? ''}
                onChange={(event) =>
                  update(selected.id, { promptTemplateId: event.target.value || undefined })
                }
              >
                <option value="">Routed automatically</option>
                {settings.promptTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Card>
            <CardRow>
              <SwitchRow
                checked={selected.useWorktree}
                onChange={(useWorktree) => update(selected.id, { useWorktree })}
                label="Own git worktree"
              />
            </CardRow>
            <CardRow>
              <SwitchRow
                checked={selected.orchestrate}
                onChange={(orchestrate) => update(selected.id, { orchestrate })}
                label="Orchestrate can start it"
              />
            </CardRow>
          </Card>
        </div>
      ) : null}
    </div>
  )
}
