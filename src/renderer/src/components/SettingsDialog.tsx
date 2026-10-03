import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import {
  ANSI_COLOURS,
  DEFAULT_SHORTCUTS,
  DEFAULT_THEME,
  ORCHESTRATION_LANE_LABELS,
  ORCHESTRATION_LANES,
  SHORTCUT_COMMANDS,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  type OrchestrationLane,
  type PromptTemplate,
  type AnsiColour,
  type Settings,
  type ShortcutCommand,
  type TerminalPalette,
  type ThemeSettings,
  type UpdateState
} from '@core/types.js'
import {
  acceleratorFor,
  formatAccelerator,
  isReserved,
  SHORTCUT_LABELS,
  SHORTCUT_SCOPES,
  shortcutConflicts
} from '@core/shortcuts.js'
import {
  Button,
  Checkbox,
  ColorInput,
  DirectoryInput,
  Field,
  Modal,
  Select,
  inputClass
} from './ui.js'
import { useUpdates } from '../hooks/useUpdates.js'
import { ansiLabel, TERMINAL_FONTS, TERMINAL_PALETTES, UI_FONTS } from '../hooks/useTheme.js'
import { terminalTheme } from '../lib/palette.js'

const PLACEHOLDERS = [
  '{{id}}',
  '{{title}}',
  '{{description}}',
  '{{status}}',
  '{{priority}}',
  '{{readiness}}',
  '{{project}}',
  '{{tags}}',
  '{{filePath}}',
  '{{repoPath}}',
  '{{contextFiles}}',
  '{{board}}'
]

function ThemeSlider({
  label,
  value,
  min,
  max,
  readout,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  readout: string
  onChange: (value: number) => void
}): ReactNode {
  return (
    <label className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-[12.5px] text-ink">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-raised [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent"
      />
      <span className="w-10 shrink-0 text-right font-mono text-[11px] text-faint">{readout}</span>
    </label>
  )
}

const BASE_PRESETS = [
  { label: 'Harbour', hex: '#0d2233' },
  { label: 'Midnight', hex: '#0e1117' },
  { label: 'Graphite', hex: '#101010' },
  { label: 'Deep sea', hex: '#0b1418' },
  { label: 'Plum', hex: '#141018' },
  { label: 'Ember', hex: '#1d0f0f' },
  { label: 'Moss', hex: '#0d1410' }
]

const LANE_HINTS: Record<OrchestrationLane, string> = {
  spec: 'tasks flagged as needing a spec',
  implement: 'ready tasks in Backlog',
  review: 'tasks sitting in In Review'
}

export const SECTIONS = [
  {
    id: 'preferences',
    label: 'Preferences',
    blurb: 'Defaults for new tasks. Existing tasks keep their own settings.'
  },
  {
    id: 'workspace',
    label: 'Workspace',
    blurb: 'Where the board keeps its data and where work runs.'
  },
  { id: 'terminal', label: 'Terminal', blurb: 'How sessions are started.' },
  {
    id: 'routing',
    label: 'Prompt routing',
    blurb: 'Which template runs for a task, based on where it sits.'
  },
  { id: 'templates', label: 'Templates', blurb: 'The prompts themselves.' },
  {
    id: 'orchestration',
    label: 'Orchestrate',
    blurb: 'How many agents Orchestrate may run at once, per kind of work.'
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    blurb: 'Keys the app claims. Everything else is passed to the terminal.'
  },
  { id: 'theme', label: 'Theme', blurb: 'Colours and fonts. Changes apply as you make them.' },
  { id: 'integrations', label: 'Integrations', blurb: 'Connecting the board to Claude.' },
  { id: 'updates', label: 'Updates', blurb: 'New versions download in the background.' }
] as const

function describeUpdate(state: UpdateState | null): string {
  switch (state?.kind) {
    case undefined:
    case 'idle':
      return 'Not checked yet.'
    case 'unsupported':
      return 'Updates are off when running from source. Install a release to get them.'
    case 'checking':
      return 'Checking for updates…'
    case 'current':
      return `You're up to date. Last checked ${new Date(state.checkedAt).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
      })}.`
    case 'downloading':
      return `Downloading ${state.version}… ${state.percent}%`
    case 'ready':
      return `Version ${state.version} is ready. It installs when you quit Styr, or restart now.`
    case 'error':
      return `Couldn't check for updates: ${state.message}`
  }
}

const PREVIEW_SLOTS: AnsiColour[] = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']

function samePalette(a: TerminalPalette, b: TerminalPalette): boolean {
  return ANSI_COLOURS.every((slot) => a[slot].toLowerCase() === b[slot].toLowerCase())
}

export type SectionId = (typeof SECTIONS)[number]['id']

function ShortcutRow({
  command,
  bindings,
  conflicted,
  onChange
}: {
  command: ShortcutCommand
  bindings: string[]
  conflicted: boolean
  onChange: (next: string[]) => void
}): ReactNode {
  const [recording, setRecording] = useState(false)
  const [rejected, setRejected] = useState('')

  function capture(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setRecording(false)
      setRejected('')
      return
    }
    const accelerator = acceleratorFor(event)
    if (!accelerator) return
    if (isReserved(accelerator)) {
      setRejected(`${formatAccelerator(accelerator)} belongs to the terminal`)
      return
    }
    onChange([accelerator])
    setRecording(false)
    setRejected('')
  }

  const isDefault = bindings.join(' ') === DEFAULT_SHORTCUTS[command].join(' ')

  return (
    <div className="flex items-center gap-3 border-b border-edge/60 py-2 last:border-b-0">
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-[12.5px]">{SHORTCUT_LABELS[command]}</span>
        {SHORTCUT_SCOPES[command] === 'terminal' ? (
          <span className="shrink-0 text-[11px] text-faint">in the terminal</span>
        ) : null}
      </span>

      <div className="flex shrink-0 items-center gap-1">
        {bindings.length === 0 ? (
          <span className="text-[11px] text-faint">Not bound</span>
        ) : (
          bindings.map((accelerator) => (
            <kbd
              key={accelerator}
              className={`rounded border px-1.5 py-[2px] font-mono text-[11px] ${
                conflicted
                  ? 'border-col-review text-col-review-text'
                  : 'border-edge-strong text-dim'
              }`}
            >
              {formatAccelerator(accelerator)}
            </kbd>
          ))
        )}
      </div>

      <button
        type="button"
        onKeyDown={recording ? capture : undefined}
        onBlur={() => setRecording(false)}
        onClick={() => {
          setRecording((on) => !on)
          setRejected('')
        }}
        className={`w-[108px] shrink-0 rounded-lg border px-2 py-1 text-[11.5px] transition-colors ${
          recording
            ? 'border-accent bg-accent/15 text-accent-text'
            : 'border-edge-strong text-dim hover:text-ink'
        }`}
      >
        {recording ? 'Press keys…' : 'Change'}
      </button>

      <button
        type="button"
        disabled={isDefault && bindings.length > 0}
        className="w-14 shrink-0 text-[11px] text-faint underline-offset-2 hover:text-ink disabled:opacity-30 disabled:hover:text-faint"
        onClick={() => onChange([...DEFAULT_SHORTCUTS[command]])}
      >
        Reset
      </button>

      <button
        type="button"
        disabled={bindings.length === 0}
        className="w-12 shrink-0 text-[11px] text-faint hover:text-ink disabled:opacity-30 disabled:hover:text-faint"
        onClick={() => onChange([])}
      >
        Clear
      </button>

      {rejected ? (
        <span className="shrink-0 text-[11px] text-col-review-text">{rejected}</span>
      ) : null}
    </div>
  )
}

function slugId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'template'
  )
}

function TemplatePicker({
  label,
  templates,
  value,
  onChange
}: {
  label: string
  templates: PromptTemplate[]
  value: string
  onChange: (id: string) => void
}): ReactNode {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-faint">{label}</span>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
      </Select>
    </label>
  )
}

export function SettingsDialog({
  settings,
  initialSection,
  onSave,
  onPreviewTheme,
  onClose
}: {
  settings: Settings
  initialSection?: SectionId
  onSave: (next: Settings) => Promise<void>
  /** Applies a draft theme to the live app so combinations can be judged before saving. */
  onPreviewTheme: (theme: ThemeSettings | null) => void
  onClose: () => void
}): ReactNode {
  const [draft, setDraft] = useState<Settings>(settings)
  const [section, setSection] = useState<SectionId>(initialSection ?? 'preferences')
  const [selectedId, setSelectedId] = useState<string>(
    settings.promptTemplates[0]?.id ?? settings.defaultPromptTemplateId
  )
  const [mcpCommand, setMcpCommand] = useState('')
  const [codexMcpCommand, setCodexMcpCommand] = useState('')
  const [copied, setCopied] = useState(false)
  const [ansiSlot, setAnsiSlot] = useState<AnsiColour>('red')
  const [version, setVersion] = useState('')
  const update = useUpdates()

  useEffect(() => {
    void window.api.app.mcpCommand('claude').then(setMcpCommand)
    void window.api.app.mcpCommand('codex').then(setCodexMcpCommand)
    void window.api.app.info().then((info) => setVersion(info.version))
  }, [])

  const selected = draft.promptTemplates.find((template) => template.id === selectedId) ?? null
  const active = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0]
  const conflicts = shortcutConflicts(draft.shortcuts)
  const preview = terminalTheme(draft.theme)

  const patch = (changes: Partial<Settings>): void =>
    setDraft((current) => {
      const next = { ...current, ...changes }
      if (changes.theme) onPreviewTheme(changes.theme)
      return next
    })

  function toggleProvider(provider: 'claude' | 'codex', enabled: boolean): void {
    const enabledProviders = enabled
      ? [...new Set([...draft.enabledProviders, provider])]
      : draft.enabledProviders.filter((item) => item !== provider)
    if (enabledProviders.length === 0) return
    patch({
      enabledProviders,
      defaultProvider: enabledProviders.includes(draft.defaultProvider)
        ? draft.defaultProvider
        : enabledProviders[0]!
    })
  }

  function updateTemplate(changes: Partial<PromptTemplate>): void {
    if (!selected) return
    patch({
      promptTemplates: draft.promptTemplates.map((template) =>
        template.id === selected.id ? { ...template, ...changes } : template
      )
    })
  }

  function addTemplate(): void {
    const id = slugId(`template ${draft.promptTemplates.length + 1}`)
    patch({
      promptTemplates: [
        ...draft.promptTemplates,
        { id, name: 'New template', template: 'Work on {{id}}: {{title}}\n\n{{description}}' }
      ]
    })
    setSelectedId(id)
  }

  function removeTemplate(): void {
    if (!selected || draft.promptTemplates.length <= 1) return
    const remaining = draft.promptTemplates.filter((template) => template.id !== selected.id)
    patch({
      promptTemplates: remaining,
      defaultPromptTemplateId:
        draft.defaultPromptTemplateId === selected.id
          ? (remaining[0]?.id ?? 'default')
          : draft.defaultPromptTemplateId
    })
    setSelectedId(remaining[0]?.id ?? '')
  }

  return (
    <Modal
      wide
      flush
      title="Settings"
      subtitle="Stored in ~/.styr/config.json"
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          onClick={() => {
            void onSave(draft).then(() => {
              onPreviewTheme(null)
              onClose()
            })
          }}
        >
          Save settings
        </Button>
      }
    >
      <div className="flex h-[min(560px,68vh)] min-h-0 w-full">
        <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-edge bg-chrome/40 p-2">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={item.id === section}
              className={`rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                item.id === section
                  ? 'bg-raised font-medium text-ink'
                  : 'text-dim hover:bg-raised/60 hover:text-ink'
              }`}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto px-5 py-5">
          <header className="mb-4">
            <h3 className="text-[13.5px] font-semibold tracking-[-0.01em]">{active.label}</h3>
            <p className="mt-0.5 text-[11.5px] text-faint">{active.blurb}</p>
          </header>

          {section === 'preferences' ? (
            <div className="flex flex-col gap-4">
              <Checkbox
                checked={draft.taskDefaults.orchestrate}
                onChange={(orchestrate) =>
                  patch({ taskDefaults: { ...draft.taskDefaults, orchestrate } })
                }
                label="Let Orchestrate start new tasks"
                hint="When on, the Orchestrate checkbox is ticked when you create a task. You can still change it per task."
              />
              <Checkbox
                checked={draft.taskDefaults.useWorktree}
                onChange={(useWorktree) =>
                  patch({ taskDefaults: { ...draft.taskDefaults, useWorktree } })
                }
                label="Run new tasks in their own git worktree"
                hint="When on, the worktree checkbox is ticked when you create a task. Each agent then gets a separate checkout."
              />
            </div>
          ) : null}

          {section === 'workspace' ? (
            <div className="flex flex-col gap-4">
              <Field
                label="Board storage folder"
                hint="Where the app keeps your tasks (./tasks/*.md) and its index. This is the board's own data, not your code — point it at a git repo if you want versioned tasks."
              >
                <DirectoryInput
                  value={draft.workspaceDir}
                  onChange={(workspaceDir) => patch({ workspaceDir })}
                />
              </Field>

              <Field
                label="Default working directory"
                hint="Pre-fills Working directory on new tasks, and is where + Shell opens. Leave blank to fall back to the board storage folder."
              >
                <DirectoryInput
                  value={draft.defaultRepoPath}
                  onChange={(defaultRepoPath) => patch({ defaultRepoPath })}
                />
              </Field>
            </div>
          ) : null}

          {section === 'terminal' ? (
            <div className="flex flex-col gap-4">
              <Field label="Shell" hint="The shell each embedded terminal session runs.">
                <input
                  className={inputClass}
                  value={draft.shell}
                  onChange={(event) => patch({ shell: event.target.value })}
                />
              </Field>
            </div>
          ) : null}

          {section === 'routing' ? (
            <div className="flex flex-col gap-4">
              <Field
                label="Agent for each lane"
                hint="Orchestrate uses these providers. Claude remains the default until you opt a lane into Codex."
              >
                <div className="grid grid-cols-3 gap-2.5 rounded-lg border border-edge bg-chrome/40 p-3">
                  {(['spec', 'implement', 'review'] as const).map((lane) => (
                    <label
                      key={lane}
                      className="flex flex-col gap-1.5 text-[11px] capitalize text-dim"
                    >
                      {lane}
                      <select
                        className={inputClass}
                        value={draft.providerRouting[lane]}
                        onChange={(event) =>
                          patch({
                            providerRouting: {
                              ...draft.providerRouting,
                              [lane]: event.target.value as 'claude' | 'codex'
                            }
                          })
                        }
                      >
                        {draft.enabledProviders.includes('claude') ? (
                          <option value="claude">Claude Code</option>
                        ) : null}
                        {draft.enabledProviders.includes('codex') ? (
                          <option value="codex">Codex</option>
                        ) : null}
                      </select>
                    </label>
                  ))}
                </div>
              </Field>
              <Field
                label="Which prompt runs where"
                hint="A task with no pinned template uses these. Needs spec wins over the column, so unspecified work always gets specced first."
              >
                <div className="grid grid-cols-2 gap-2.5 rounded-lg border border-edge bg-chrome/40 p-3">
                  <TemplatePicker
                    label="Needs spec (any column)"
                    templates={draft.promptTemplates}
                    value={draft.promptRouting.needsSpec}
                    onChange={(needsSpec) =>
                      patch({ promptRouting: { ...draft.promptRouting, needsSpec } })
                    }
                  />
                  {TASK_STATUSES.map((status) => (
                    <TemplatePicker
                      key={status}
                      label={TASK_STATUS_LABELS[status]}
                      templates={draft.promptTemplates}
                      value={draft.promptRouting.byStatus[status]}
                      onChange={(id) =>
                        patch({
                          promptRouting: {
                            ...draft.promptRouting,
                            byStatus: { ...draft.promptRouting.byStatus, [status]: id }
                          }
                        })
                      }
                    />
                  ))}
                </div>
              </Field>

              <Field
                label="Fallback template"
                hint="Used only if a routing entry above points at a template that no longer exists."
              >
                <Select
                  value={draft.defaultPromptTemplateId}
                  onChange={(event) => patch({ defaultPromptTemplateId: event.target.value })}
                >
                  {draft.promptTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          ) : null}

          {section === 'templates' ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-end gap-2">
                <Field label="Editing">
                  <Select
                    value={selectedId}
                    onChange={(event) => setSelectedId(event.target.value)}
                  >
                    {draft.promptTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button className="shrink-0" onClick={addTemplate}>
                  Add
                </Button>
                <Button
                  variant="danger"
                  className="shrink-0"
                  onClick={removeTemplate}
                  disabled={draft.promptTemplates.length <= 1}
                >
                  Remove
                </Button>
              </div>

              {selected ? (
                <>
                  <Field label="Name">
                    <input
                      className={inputClass}
                      value={selected.name}
                      onChange={(event) => updateTemplate({ name: event.target.value })}
                    />
                  </Field>
                  <Field
                    label="Body"
                    hint="The board protocol and any context files are added automatically if you leave their placeholders out."
                  >
                    <textarea
                      className={`${inputClass} min-h-52 resize-y font-mono text-[12px] leading-relaxed`}
                      value={selected.template}
                      onChange={(event) => updateTemplate({ template: event.target.value })}
                    />
                  </Field>
                  <div>
                    <p className="mb-1.5 text-[11px] text-faint">Placeholders</p>
                    <div className="flex flex-wrap gap-1">
                      {PLACEHOLDERS.map((token) => (
                        <code
                          key={token}
                          className="rounded bg-raised px-1.5 py-[1px] font-mono text-[10.5px] text-dim"
                        >
                          {token}
                        </code>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {section === 'orchestration' ? (
            <div className="flex flex-col gap-4">
              <Field
                label="Slots per kind of work"
                hint="Orchestrate fills free slots with the highest-priority waiting tasks. A slot is taken while a task has a live session. Set a lane to 0 to have Orchestrate skip it entirely."
              >
                <div className="flex flex-col gap-2.5 rounded-lg border border-edge bg-chrome/40 p-3">
                  {ORCHESTRATION_LANES.map((lane) => (
                    <label key={lane} className="flex items-center gap-3">
                      <span className="w-28 shrink-0 text-[12.5px] text-ink">
                        {ORCHESTRATION_LANE_LABELS[lane]}
                      </span>
                      <div className="w-20 shrink-0">
                        <input
                          type="number"
                          min={0}
                          max={20}
                          className={inputClass}
                          value={draft.orchestration[lane]}
                          onChange={(event) =>
                            patch({
                              orchestration: {
                                ...draft.orchestration,
                                [lane]: Math.max(0, Math.min(20, Number(event.target.value) || 0))
                              }
                            })
                          }
                        />
                      </div>
                      <span className="text-[11px] text-faint">{LANE_HINTS[lane]}</span>
                    </label>
                  ))}
                </div>
              </Field>
            </div>
          ) : null}

          {section === 'shortcuts' ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-xl border border-edge bg-chrome/30 px-3 py-1">
                {SHORTCUT_COMMANDS.map((command) => (
                  <ShortcutRow
                    key={command}
                    command={command}
                    bindings={draft.shortcuts[command]}
                    conflicted={draft.shortcuts[command].some((accelerator) =>
                      conflicts.has(accelerator)
                    )}
                    onChange={(next) =>
                      patch({ shortcuts: { ...draft.shortcuts, [command]: next } })
                    }
                  />
                ))}
              </div>

              {conflicts.size > 0 ? (
                <p className="text-[11.5px] text-col-review-text">
                  {[...conflicts]
                    .map(
                      ([accelerator, commands]) =>
                        `${formatAccelerator(accelerator)} is bound to ${commands
                          .map((command) => SHORTCUT_LABELS[command])
                          .join(' and ')}`
                    )
                    .join('; ')}
                  . The first in the list wins.
                </p>
              ) : null}

              <p className="text-[11.5px] text-faint">
                Esc closes a dialog and ⌘↵ saves one; both are fixed. Ctrl+C, Ctrl+D, Ctrl+L,
                Ctrl+Z, Esc, Enter and Tab cannot be bound — the terminal needs them.
              </p>
            </div>
          ) : null}

          {section === 'theme' ? (
            <div className="flex flex-col gap-5">
              <Field
                label="Colours"
                hint="Base sets every surface and text colour — the interface derives a full ramp from it, so contrast holds whatever you pick. The column colours double as agent states — In Progress tints Working, In Review tints Waiting on you, Done tints Finished."
              >
                <div className="flex flex-col gap-2.5 rounded-lg border border-edge bg-chrome/40 p-3">
                  <ColorInput
                    label="Base"
                    value={draft.theme.base}
                    onChange={(base) => patch({ theme: { ...draft.theme, base } })}
                  />
                  <div className="flex items-center gap-2 pl-[2.4rem]">
                    {BASE_PRESETS.map((preset) => (
                      <button
                        key={preset.hex}
                        type="button"
                        title={preset.label}
                        aria-label={preset.label}
                        onClick={() => patch({ theme: { ...draft.theme, base: preset.hex } })}
                        style={{ backgroundColor: preset.hex }}
                        className={`size-5 rounded-md border transition-colors ${
                          draft.theme.base.toLowerCase() === preset.hex
                            ? 'border-accent'
                            : 'border-edge-strong hover:border-faint'
                        }`}
                      />
                    ))}
                    <span className="text-[11px] text-faint">presets</span>
                    <button
                      type="button"
                      className="ml-auto text-[11px] text-dim underline decoration-edge-strong underline-offset-2 hover:text-ink"
                      onClick={() => patch({ theme: DEFAULT_THEME })}
                    >
                      Reset to defaults
                    </button>
                  </div>
                  <div className="pt-1">
                    <Checkbox
                      checked={draft.theme.gradient}
                      onChange={(gradient) => patch({ theme: { ...draft.theme, gradient } })}
                      label="Gradient background"
                      hint="Washes the base colour with a hint of the accent, the way Warp does it."
                    />
                    {draft.theme.gradient ? (
                      <div className="mt-2.5 flex flex-col gap-2 pl-[1.6rem]">
                        <ThemeSlider
                          label="Strength"
                          value={Math.round(draft.theme.gradientStrength * 100)}
                          min={0}
                          max={100}
                          readout={`${Math.round(draft.theme.gradientStrength * 100)}%`}
                          onChange={(value) =>
                            patch({ theme: { ...draft.theme, gradientStrength: value / 100 } })
                          }
                        />
                        <ThemeSlider
                          label="Angle"
                          value={draft.theme.gradientAngle}
                          min={0}
                          max={359}
                          readout={`${draft.theme.gradientAngle}°`}
                          onChange={(gradientAngle) =>
                            patch({ theme: { ...draft.theme, gradientAngle } })
                          }
                        />
                      </div>
                    ) : null}
                  </div>
                  <ColorInput
                    label="Accent"
                    value={draft.theme.accent}
                    onChange={(accent) => patch({ theme: { ...draft.theme, accent } })}
                  />
                  {TASK_STATUSES.map((status) => (
                    <ColorInput
                      key={status}
                      label={TASK_STATUS_LABELS[status]}
                      value={draft.theme.columns[status]}
                      onChange={(hex) =>
                        patch({
                          theme: {
                            ...draft.theme,
                            columns: { ...draft.theme.columns, [status]: hex }
                          }
                        })
                      }
                    />
                  ))}
                </div>
              </Field>

              <Field label="Interface font">
                <Select
                  value={draft.theme.uiFont}
                  onChange={(event) =>
                    patch({ theme: { ...draft.theme, uiFont: event.target.value } })
                  }
                >
                  {UI_FONTS.map((font) => (
                    <option key={font.id} value={font.id}>
                      {font.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <div className="grid grid-cols-[1fr_6rem] gap-3">
                <Field label="Terminal font">
                  <Select
                    value={draft.theme.terminalFont}
                    onChange={(event) =>
                      patch({ theme: { ...draft.theme, terminalFont: event.target.value } })
                    }
                  >
                    {TERMINAL_FONTS.map((font) => (
                      <option key={font.label} value={font.stack}>
                        {font.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Size">
                  <input
                    type="number"
                    min={9}
                    max={24}
                    className={inputClass}
                    value={draft.theme.terminalFontSize}
                    onChange={(event) =>
                      patch({
                        theme: {
                          ...draft.theme,
                          terminalFontSize: Math.max(
                            9,
                            Math.min(24, Number(event.target.value) || 12)
                          )
                        }
                      })
                    }
                  />
                </Field>
              </div>

              <Field
                label="Terminal colours"
                hint="The background, text and cursor follow the base colour. These 16 are what programs pick from — git diffs, Claude's output, your prompt — so they are set outright."
              >
                <div className="flex flex-col gap-3 rounded-lg border border-edge bg-chrome/40 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {TERMINAL_PALETTES.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() =>
                          patch({ theme: { ...draft.theme, terminalPalette: preset.palette } })
                        }
                        className={`flex items-center gap-2 rounded-lg border px-2 py-1 text-[11.5px] transition-colors ${
                          samePalette(draft.theme.terminalPalette, preset.palette)
                            ? 'border-accent text-ink'
                            : 'border-edge-strong text-dim hover:text-ink'
                        }`}
                      >
                        <span className="flex">
                          {PREVIEW_SLOTS.map((slot) => (
                            <span
                              key={slot}
                              style={{ backgroundColor: preset.palette[slot] }}
                              className="size-2.5 first:rounded-l-sm last:rounded-r-sm"
                            />
                          ))}
                        </span>
                        {preset.label}
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-8 gap-1.5">
                    {ANSI_COLOURS.map((slot) => (
                      <button
                        key={slot}
                        type="button"
                        title={ansiLabel(slot)}
                        aria-label={ansiLabel(slot)}
                        aria-pressed={slot === ansiSlot}
                        onClick={() => setAnsiSlot(slot)}
                        style={{ backgroundColor: draft.theme.terminalPalette[slot] }}
                        className={`h-6 rounded-md border transition-colors ${
                          slot === ansiSlot
                            ? 'border-accent'
                            : 'border-edge-strong hover:border-faint'
                        }`}
                      />
                    ))}
                  </div>

                  <ColorInput
                    label={ansiLabel(ansiSlot)}
                    value={draft.theme.terminalPalette[ansiSlot]}
                    onChange={(hex) =>
                      patch({
                        theme: {
                          ...draft.theme,
                          terminalPalette: { ...draft.theme.terminalPalette, [ansiSlot]: hex }
                        }
                      })
                    }
                  />
                </div>
              </Field>

              <div
                className="rounded-lg border border-edge-strong p-3 font-mono leading-relaxed"
                style={{
                  fontFamily: draft.theme.terminalFont,
                  fontSize: draft.theme.terminalFontSize,
                  backgroundColor: preview.background,
                  color: preview.foreground
                }}
              >
                <span style={{ color: preview.green }}>❯</span> claude --resume TASK-0004
                <br />
                <span style={{ color: preview.brightBlack }}>---</span>{' '}
                <span style={{ color: preview.red }}>- const THEME = &#123;</span>
                <br />
                <span style={{ color: preview.brightBlack }}>+++</span>{' '}
                <span style={{ color: preview.green }}>+ terminalTheme(theme)</span>
                <br />
                <span style={{ color: preview.yellow }}>warning</span>{' '}
                <span style={{ color: preview.blue }}>src/core/shortcuts.ts</span>{' '}
                <span style={{ color: preview.magenta }}>12 passed</span>{' '}
                <span style={{ color: preview.cyan }}>0 failed</span>
                <br />
                <span style={{ backgroundColor: preview.cursor, color: preview.background }}>
                  {' '}
                </span>
              </div>
            </div>
          ) : null}

          {section === 'integrations' ? (
            <div className="flex flex-col gap-4">
              <Field
                label="Installed providers"
                hint="Enable the coding CLIs you use. At least one provider must remain enabled."
              >
                <div className="flex flex-col gap-2 rounded-lg border border-edge bg-chrome/40 p-3">
                  <Checkbox
                    checked={draft.enabledProviders.includes('claude')}
                    onChange={(enabled) => toggleProvider('claude', enabled)}
                    label="Claude Code"
                  />
                  <Checkbox
                    checked={draft.enabledProviders.includes('codex')}
                    onChange={(enabled) => toggleProvider('codex', enabled)}
                    label="Codex"
                  />
                </div>
              </Field>
              <Field
                label="Default provider"
                hint="Used by manual launches; orchestration can route each lane independently."
              >
                <Select
                  value={draft.defaultProvider}
                  onChange={(event) =>
                    patch({ defaultProvider: event.target.value as 'claude' | 'codex' })
                  }
                >
                  {draft.enabledProviders.includes('claude') ? (
                    <option value="claude">Claude Code</option>
                  ) : null}
                  {draft.enabledProviders.includes('codex') ? (
                    <option value="codex">Codex</option>
                  ) : null}
                </Select>
              </Field>
              {draft.enabledProviders.includes('claude') ? (
                <Field
                  label="Claude command"
                  hint="Usually `claude`. Use a wrapper or absolute path when needed."
                >
                  <input
                    className={inputClass}
                    value={draft.claudeCommand}
                    onChange={(event) => patch({ claudeCommand: event.target.value })}
                  />
                </Field>
              ) : null}
              {draft.enabledProviders.includes('claude') ? (
                <Field
                  label="Claude approvals"
                  hint="Approve for me sends permission prompts to Claude Code's auto mode classifier; it does not grant full access. Needs a recent Claude Code."
                >
                  <Select
                    value={draft.claudeApprovalMode}
                    onChange={(event) =>
                      patch({ claudeApprovalMode: event.target.value as 'user' | 'auto' })
                    }
                  >
                    <option value="user">Ask me</option>
                    <option value="auto">Approve for me</option>
                  </Select>
                </Field>
              ) : null}
              {draft.enabledProviders.includes('claude') ? (
                <Field
                  label="Claude MCP server"
                  hint="Run this once in a terminal, then start a new Claude session. It lets Claude query the board — what is in review, what needs a spec — from anywhere."
                >
                  <div className="flex flex-col gap-2">
                    <pre className="overflow-x-auto rounded-lg border border-edge-strong bg-chrome p-3 font-mono text-[11px] leading-relaxed text-dim">
                      {mcpCommand || 'Building command…'}
                    </pre>
                    <div className="flex items-center gap-2.5">
                      <Button
                        disabled={!mcpCommand}
                        onClick={() => {
                          void navigator.clipboard.writeText(mcpCommand).then(() => {
                            setCopied(true)
                            setTimeout(() => setCopied(false), 1600)
                          })
                        }}
                      >
                        Copy command
                      </Button>
                      {copied ? (
                        <span className="text-[11.5px] text-[var(--color-col-done)]">Copied</span>
                      ) : null}
                    </div>
                  </div>
                </Field>
              ) : null}
              {draft.enabledProviders.includes('codex') ? (
                <Field
                  label="Codex command"
                  hint="Usually `codex`. Codex always runs in the workspace-write sandbox."
                >
                  <input
                    className={inputClass}
                    value={draft.codexCommand}
                    onChange={(event) => patch({ codexCommand: event.target.value })}
                  />
                </Field>
              ) : null}
              {draft.enabledProviders.includes('codex') ? (
                <Field
                  label="Codex approvals"
                  hint="Approve for me sends eligible requests to Codex’s automatic reviewer; it does not grant full access."
                >
                  <Select
                    value={draft.codexApprovalReviewer}
                    onChange={(event) =>
                      patch({
                        codexApprovalReviewer: event.target.value as 'user' | 'auto_review'
                      })
                    }
                  >
                    <option value="user">Ask me</option>
                    <option value="auto_review">Approve for me</option>
                  </Select>
                </Field>
              ) : null}
              {draft.enabledProviders.includes('codex') ? (
                <Field
                  label="Codex MCP server"
                  hint="Run this once, then start a new Codex session to let it query and update the board."
                >
                  <div className="flex flex-col gap-2">
                    <pre className="overflow-x-auto rounded-lg border border-edge-strong bg-chrome p-3 font-mono text-[11px] leading-relaxed text-dim">
                      {codexMcpCommand || 'Building command…'}
                    </pre>
                    <Button
                      disabled={!codexMcpCommand}
                      onClick={() => void navigator.clipboard.writeText(codexMcpCommand)}
                    >
                      Copy command
                    </Button>
                  </div>
                </Field>
              ) : null}
            </div>
          ) : null}

          {section === 'updates' ? (
            <div className="flex flex-col gap-4">
              <Field label="Current version">
                <span className="font-mono text-[12px] text-ink">{version || '…'}</span>
              </Field>
              <Field label="Status">
                <div className="flex flex-col gap-2.5">
                  <span
                    className={`text-[12px] ${update?.kind === 'error' ? 'text-red-300/90' : 'text-dim'}`}
                  >
                    {describeUpdate(update)}
                  </span>
                  <div className="flex items-center gap-2.5">
                    {update?.kind === 'ready' ? (
                      <Button variant="primary" onClick={() => void window.api.updates.install()}>
                        Restart to update
                      </Button>
                    ) : (
                      <Button
                        disabled={
                          !update ||
                          update.kind === 'unsupported' ||
                          update.kind === 'checking' ||
                          update.kind === 'downloading'
                        }
                        onClick={() => void window.api.updates.check()}
                      >
                        Check for updates
                      </Button>
                    )}
                  </div>
                </div>
              </Field>
              <Checkbox
                checked={draft.updates.checkAutomatically}
                onChange={(checkAutomatically) => patch({ updates: { checkAutomatically } })}
                label="Check for updates automatically"
                hint="When Styr opens and every few hours after. An update downloads in the background and installs the next time you quit, so running agents are never interrupted."
              />
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
