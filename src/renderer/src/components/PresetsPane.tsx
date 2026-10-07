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
import { Card, CardRow, Eyebrow, Field, Hint, Select, SwitchRow, inputBase } from './ui.js'

const BLANK: Omit<TaskPreset, 'id' | 'name'> = {
  title: '',
  description: '',
  tags: [],
  priority: 'medium',
  readiness: 'ready',
  useWorktree: false,
  orchestrate: true
}

function Svg({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

const ICON_BUTTON =
  'grid size-8 shrink-0 place-items-center rounded-[7px] text-dim transition-colors hover:bg-raised/70 hover:text-ink disabled:pointer-events-none disabled:opacity-35'

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
  const selected = presets.find((preset) => preset.id === selectedId) ?? presets[0] ?? null
  const index = selected ? presets.findIndex((preset) => preset.id === selected.id) : -1
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

  function move(by: -1 | 1): void {
    const target = index + by
    if (index < 0 || target < 0 || target >= presets.length) return
    const next = [...presets]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    onChange(next)
  }

  const nameClash = selected ? presetNameTaken(presets, selected.name, selected.id) : false
  const nameEmpty = selected ? selected.name.trim() === '' : false

  return (
    <div className="grid grid-cols-[190px_minmax(0,1fr)] gap-5">
      <div className="flex flex-col gap-0.5">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-current={preset.id === selected?.id}
            onClick={() => setSelectedId(preset.id)}
            className={`flex flex-col items-start gap-0.5 rounded-[7px] border px-[9px] py-[7px] text-left transition-colors ${
              preset.id === selected?.id
                ? 'border-edge-strong bg-raised'
                : 'border-transparent hover:bg-raised/70'
            }`}
          >
            <span className="w-full truncate text-[12.5px] font-medium text-ink">
              {preset.name || 'Untitled'}
            </span>
            <span className="text-[11px] text-faint">
              {TASK_PRIORITY_LABELS[preset.priority]} · {TASK_READINESS_LABELS[preset.readiness]}
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={add}
          disabled={!canAddPreset(presets)}
          className="mt-1 inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-dashed border-edge-strong px-[9px] text-[12px] font-medium text-dim transition-colors hover:border-faint hover:text-ink disabled:pointer-events-none disabled:opacity-40"
        >
          <Svg>
            <path d="M8 3.5v9M3.5 8h9" />
          </Svg>
          New preset
        </button>
        {!canAddPreset(presets) ? <Hint>At most {MAX_TASK_PRESETS} presets.</Hint> : null}
      </div>

      {selected ? (
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex items-center gap-1">
            <input
              aria-label="Preset name"
              aria-invalid={nameClash || nameEmpty}
              className={`${inputBase} mr-1 h-8 min-w-0 flex-1 px-2.5 text-[13px] font-semibold`}
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
            />
            <button
              type="button"
              aria-label="Move up"
              title="Move up"
              disabled={index <= 0}
              onClick={() => move(-1)}
              className={ICON_BUTTON}
            >
              <Svg>
                <path d="M4 10l4-4 4 4" />
              </Svg>
            </button>
            <button
              type="button"
              aria-label="Move down"
              title="Move down"
              disabled={index < 0 || index >= presets.length - 1}
              onClick={() => move(1)}
              className={ICON_BUTTON}
            >
              <Svg>
                <path d="M4 6l4 4 4-4" />
              </Svg>
            </button>
            <button
              type="button"
              aria-label="Duplicate preset"
              title="Duplicate preset"
              disabled={!canAddPreset(presets)}
              onClick={() => duplicate(selected)}
              className={ICON_BUTTON}
            >
              <Svg>
                <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.2" />
                <path d="M10.5 3.5h-6a1 1 0 0 0-1 1v6" />
              </Svg>
            </button>
            <button
              type="button"
              aria-label="Delete preset"
              title="Delete preset"
              onClick={() => remove(selected.id)}
              className={`${ICON_BUTTON} !text-danger hover:!bg-red-500/10`}
            >
              <Svg>
                <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
              </Svg>
            </button>
          </div>
          {nameClash || nameEmpty ? (
            <span role="alert" className="-mt-3 text-[11.5px] text-danger">
              {nameEmpty ? 'A name is required.' : 'Another preset already has this name.'}
            </span>
          ) : null}

          <div className="flex flex-col gap-2.5">
            <Eyebrow>Fills in</Eyebrow>
            <Field label="Title" hint="Leave empty to type it each time.">
              <input
                aria-label="Preset title"
                className={`${inputBase} h-8 w-full px-2.5 text-[12.5px]`}
                value={selected.title}
                onChange={(event) => update(selected.id, { title: event.target.value })}
              />
            </Field>
            <Field label="Description">
              <textarea
                aria-label="Preset description"
                rows={6}
                className={`${inputBase} w-full resize-y px-3 py-2.5 font-mono text-[12px] leading-[1.65]`}
                value={selected.description}
                onChange={(event) => update(selected.id, { description: event.target.value })}
              />
            </Field>
            <Field label="Tags" hint="Comma separated.">
              <input
                aria-label="Preset tags"
                className={`${inputBase} h-8 w-full px-2.5 text-[12.5px]`}
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
              />
            </Field>
          </div>

          <div className="flex flex-col gap-2.5">
            <Eyebrow>Properties</Eyebrow>
            <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
              <Field label="Priority">
                <Select
                  compact
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
                  compact
                  aria-label="Preset readiness"
                  value={selected.readiness}
                  onChange={(event) =>
                    update(selected.id, {
                      readiness: event.target.value as TaskPreset['readiness']
                    })
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
                  compact
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
                  compact
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
                  hint="Each agent gets a separate checkout on a styr/TASK-… branch."
                />
              </CardRow>
              <CardRow>
                <SwitchRow
                  checked={selected.orchestrate}
                  onChange={(orchestrate) => update(selected.id, { orchestrate })}
                  label="Orchestrate can start it"
                  hint="Orchestrate may pick the task up when a slot is free."
                />
              </CardRow>
            </Card>
          </div>
        </div>
      ) : (
        <p className="pt-1.5 text-[12.5px] text-dim">
          No presets. The New task dialog starts blank. Add one to reuse a setup.
        </p>
      )}
    </div>
  )
}
