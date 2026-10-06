import {
  useCallback,
  useEffect,
  useRef,
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
  type SettingsChange,
  type ShortcutCommand,
  type TerminalPalette,
  type ExperimentalSettings,
  type ThemeSettings,
  type UpdateState,
  type WorkspaceSettings,
  globalSettingsFor,
  workspaceSettingsFor
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
  Card,
  CardRow,
  Chip,
  ColorInput,
  ColorPopover,
  ColorSwatch,
  DirectoryInput,
  Eyebrow,
  Field,
  Hint,
  Modal,
  Segmented,
  Select,
  Stepper,
  Switch,
  SwitchRow,
  inputBase
} from './ui.js'
import { WorkspacesPane } from './WorkspacesPane.js'
import { SourcesPane } from './SourcesPane.js'
import type { Workspaces } from '../hooks/useWorkspaces.js'
import { useUpdates } from '../hooks/useUpdates.js'
import { useWorkspaceTarget } from '../hooks/useWorkspaceTarget.js'
import { ansiLabel, TERMINAL_FONTS, TERMINAL_PALETTES, UI_FONTS } from '../hooks/useTheme.js'
import { terminalTheme } from '../lib/palette.js'
import { THEME_PRESETS, applyPreset } from '../lib/themePresets.js'
import { workspaceColor } from '../lib/workspaceColor.js'

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
    <label className="grid grid-cols-[72px_minmax(0,1fr)_40px] items-center gap-2.5">
      <span className="text-[12px] text-dim">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full cursor-pointer accent-[var(--color-accent)]"
      />
      <span className="text-right font-mono text-[11px] text-faint">{readout}</span>
    </label>
  )
}

const LANE_HINTS: Record<OrchestrationLane, string> = {
  spec: 'tasks flagged as needing a spec',
  implement: 'ready tasks in Backlog',
  review: 'tasks sitting in In Review'
}

/**
 * `scope` says where a section's values are kept: `workspace` sections edit the workspace picked in
 * the dialog, `app` sections are shared by every workspace. `keys` lists the `Settings` keys a
 * section edits, which is how the nav knows which sections have unsaved changes; `words` feeds the
 * search box.
 */
export const SECTIONS = [
  {
    id: 'preferences',
    label: 'General',
    scope: 'workspace',
    blurb: 'Defaults for new tasks in this workspace. Existing tasks keep their own settings.',
    keys: ['taskDefaults', 'doneCap', 'defaultRepoPath', 'shell', 'openFilesWith'],
    words:
      'done cap archive hide limit worktree directory shell terminal orchestrate default preferences open editor app markdown'
  },
  {
    id: 'agents',
    label: 'Agents',
    scope: 'workspace',
    blurb: 'The coding CLIs Styr can launch, and how to reach them.',
    keys: [
      'enabledProviders',
      'defaultProvider',
      'claudeCommand',
      'claudeApprovalMode',
      'codexCommand',
      'codexApprovalReviewer'
    ],
    words: 'claude codex provider mcp command approvals agents'
  },
  {
    id: 'source-github',
    label: 'GitHub',
    group: 'integrations',
    scope: 'workspace',
    blurb: 'Link GitHub issues to tasks. Read-only sources are never written to.',
    keys: ['sources'],
    flag: 'externalSources',
    words: 'github issues sync gh external source integrations'
  },
  {
    id: 'routing',
    label: 'Prompt routing',
    scope: 'workspace',
    blurb: 'Which template runs when you press Start, based on where the task sits.',
    keys: ['promptRouting', 'defaultPromptTemplateId', 'providerRouting'],
    words: 'template column spec fallback agent lane'
  },
  {
    id: 'templates',
    label: 'Templates',
    scope: 'workspace',
    blurb: 'The prompts agents receive. Placeholders are filled from the task.',
    keys: ['promptTemplates'],
    words: 'prompt placeholder body'
  },
  {
    id: 'orchestration',
    label: 'Orchestrate',
    scope: 'workspace',
    blurb: 'Which agent picks up each kind of work, and how many run at once.',
    keys: ['orchestration'],
    words: 'slots lanes parallel concurrency'
  },
  {
    id: 'theme',
    label: 'Theme',
    scope: 'workspace',
    blurb: 'Colours and fonts. Changes preview live while this workspace is open.',
    keys: ['theme'],
    words: 'colour color font gradient terminal palette appearance'
  },
  {
    id: 'workspaces',
    label: 'Workspaces',
    scope: 'app',
    blurb: 'Separate boards, each with its own tasks, agents and settings.',
    keys: [],
    words: 'board'
  },
  {
    id: 'storage',
    label: 'Storage',
    scope: 'app',
    blurb: 'Where Styr keeps tasks and its index.',
    keys: ['storageDir'],
    words: 'folder data git'
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    scope: 'app',
    blurb: 'Keys Styr claims. Everything else goes to the terminal.',
    keys: ['shortcuts'],
    words: 'keyboard keys bindings'
  },
  {
    id: 'updates',
    label: 'Updates',
    scope: 'app',
    blurb: 'Keep Styr current.',
    keys: ['updates'],
    words: 'version release'
  },
  {
    id: 'experimental',
    label: 'Experimental',
    scope: 'app',
    blurb: 'Features still being tried out. Each one stays hidden until you switch it on.',
    keys: ['experimental'],
    words: 'beta preview labs flags features github sources'
  }
] as const satisfies readonly {
  id: string
  label: string
  /** The nav heading it sits under; defaults to its scope. */
  group?: 'integrations'
  /** Hidden unless this experimental feature is switched on. */
  flag?: keyof ExperimentalSettings
  scope: 'workspace' | 'app'
  blurb: string
  keys: readonly (keyof Settings)[]
  words: string
}[]

type SectionScope = (typeof SECTIONS)[number]['scope']

/** Where a section's values are stored and which workspaces they reach. */
function scopeNoteFor(scope: SectionScope, workspaceName: string): string {
  return scope === 'app'
    ? 'Stored in ~/.styr/config.json and shared by every workspace.'
    : `Stored in the ${workspaceName} workspace folder and applies to it only.`
}

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
  const keys = bindings.length === 0 ? 'Not bound' : bindings.map(formatAccelerator).join(' ')

  return (
    <div className="flex items-center gap-3 border-t border-edge py-2 pl-3.5 pr-2.5 first:border-t-0">
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-[12.5px] text-ink">{SHORTCUT_LABELS[command]}</span>
        {SHORTCUT_SCOPES[command] === 'terminal' ? (
          <span className="shrink-0 text-[11px] text-faint">in the terminal</span>
        ) : null}
      </span>

      {rejected ? (
        <span className="shrink-0 text-[11px] text-col-review-text">{rejected}</span>
      ) : null}

      {bindings.length > 0 ? (
        <button
          type="button"
          className="h-6 rounded-md px-1.5 text-[11.5px] text-faint transition-colors hover:text-ink"
          onClick={() => onChange([])}
        >
          Clear
        </button>
      ) : null}
      {!isDefault || bindings.length === 0 ? (
        <button
          type="button"
          className="h-6 rounded-md px-1.5 text-[11.5px] text-faint transition-colors hover:text-ink"
          onClick={() => onChange([...DEFAULT_SHORTCUTS[command]])}
        >
          Reset
        </button>
      ) : null}

      <button
        type="button"
        title="Click, then press the new keys"
        onKeyDown={recording ? capture : undefined}
        onBlur={() => setRecording(false)}
        onClick={() => {
          setRecording((on) => !on)
          setRejected('')
        }}
        className={`inline-flex h-[26px] min-w-24 items-center justify-center rounded-[7px] border px-2 font-mono text-[11.5px] transition-colors ${
          recording
            ? 'border-accent bg-accent/15 text-[var(--color-accent-text)]'
            : conflicted
              ? 'border-col-review bg-panel text-col-review-text'
              : 'border-edge-strong bg-panel text-ink hover:border-faint'
        }`}
      >
        {recording ? 'Press keys…' : keys}
      </button>
    </div>
  )
}

const COLUMN_TOKENS = {
  backlog: 'backlog',
  in_progress: 'progress',
  in_review: 'review',
  done: 'done'
} as const

/** Which routing slots point at a template, for the template list's subtitle. */
function routedTo(settings: Settings, id: string): string {
  const used = [
    settings.promptRouting.needsSpec === id ? 'Needs spec' : null,
    ...TASK_STATUSES.map((status) =>
      settings.promptRouting.byStatus[status] === id ? TASK_STATUS_LABELS[status] : null
    )
  ].filter((label): label is string => label !== null)
  return used.length > 0 ? used.join(', ') : 'Not routed'
}

function RouteArrow(): ReactNode {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-faint"
    >
      <path d="M3 8h9.5M9 4.5 12.5 8 9 11.5" />
    </svg>
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

const OTHER_APP = '\u0000other'

/** Picks the app that opens files: the system default, an installed app, or one found by browsing. */
function OpenWithSelect({
  value,
  onChange
}: {
  value: string
  onChange: (value: string) => void
}): ReactNode {
  const [apps, setApps] = useState<string[]>([])
  useEffect(() => {
    void window.api.settings.listApps().then(setApps)
  }, [])
  const options = value && !apps.includes(value) ? [value, ...apps] : apps
  return (
    <div className="w-60">
      <Select
        compact
        aria-label="Open files with"
        value={value}
        onChange={(event) => {
          if (event.target.value !== OTHER_APP) return onChange(event.target.value)
          void window.api.settings.pickApp().then((picked) => picked && onChange(picked))
        }}
      >
        <option value="">System default</option>
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        <option value={OTHER_APP}>Other…</option>
      </Select>
    </div>
  )
}

function TemplateSelect({
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
    <Select
      compact
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {templates.map((template) => (
        <option key={template.id} value={template.id}>
          {template.name}
        </option>
      ))}
    </Select>
  )
}

export function SettingsDialog({
  settings,
  workspaces,
  initialSection,
  onSave,
  onPreviewTheme,
  onClose
}: {
  settings: Settings
  workspaces: Workspaces
  initialSection?: SectionId
  onSave: (change: SettingsChange) => Promise<void>
  /** Applies a draft theme to the live app so combinations can be judged before saving. */
  onPreviewTheme: (theme: ThemeSettings | null) => void
  onClose: () => void
}): ReactNode {
  const [draft, setDraft] = useState<Settings>(settings)
  const [saveError, setSaveError] = useState('')
  const [section, setSection] = useState<SectionId>(initialSection ?? 'preferences')
  const [selectedId, setSelectedId] = useState<string>(
    settings.promptTemplates[0]?.id ?? settings.defaultPromptTemplateId
  )
  const [mcpCommand, setMcpCommand] = useState('')
  const [codexMcpCommand, setCodexMcpCommand] = useState('')
  const [copied, setCopied] = useState<'claude' | 'codex' | null>(null)
  const [ansiSlot, setAnsiSlot] = useState<AnsiColour>('red')
  const [version, setVersion] = useState('')
  const [search, setSearch] = useState('')
  const [editingAnsi, setEditingAnsi] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const update = useUpdates()
  const selectFirstTemplate = useCallback(
    (loaded: WorkspaceSettings) =>
      setSelectedId(loaded.promptTemplates[0]?.id ?? loaded.defaultPromptTemplateId),
    []
  )
  const target = useWorkspaceTarget({
    settings,
    workspaces,
    draft,
    setDraft,
    onLoaded: selectFirstTemplate
  })

  useEffect(() => {
    void window.api.app.mcpCommand('claude').then(setMcpCommand)
    void window.api.app.mcpCommand('codex').then(setCodexMcpCommand)
    void window.api.app.info().then((info) => setVersion(info.version))
  }, [])

  const selected = draft.promptTemplates.find((template) => template.id === selectedId) ?? null
  const flagOn = (item: (typeof SECTIONS)[number]): boolean =>
    !('flag' in item) || draft.experimental[item.flag]
  const active = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0]
  const activeHidden = !flagOn(active)
  const conflicts = shortcutConflicts(draft.shortcuts)
  const preview = terminalTheme(draft.theme)
  // What is on disk now: the app-level values, with the edited workspace's own laid over them.
  const baseline: Settings = { ...settings, ...target.savedWorkspaceSettings }
  const isChanged = (key: keyof Settings): boolean =>
    JSON.stringify(draft[key]) !== JSON.stringify(baseline[key])
  const dirtySections = new Set(
    SECTIONS.filter((item) => item.keys.some(isChanged)).map((item) => item.id)
  )
  const dirtyCount = SECTIONS.reduce((count, item) => count + item.keys.filter(isChanged).length, 0)
  const dirtyLabel = `${dirtyCount} unsaved ${dirtyCount === 1 ? 'change' : 'changes'}`
  const themeEdited =
    JSON.stringify(draft.theme) !== JSON.stringify(target.savedWorkspaceSettings.theme)
  const previewedTheme = target.editingActiveWorkspace && themeEdited ? draft.theme : null
  const query = search.trim().toLowerCase()
  const matches = (item: (typeof SECTIONS)[number]): boolean =>
    flagOn(item) && (!query || `${item.label} ${item.words}`.toLowerCase().includes(query))
  const groupOf = (item: (typeof SECTIONS)[number]): string =>
    'group' in item ? item.group : item.scope
  const navGroups = [
    { label: 'Workspace', picker: true, key: 'workspace' },
    { label: 'Integrations', picker: false, key: 'integrations' },
    { label: 'All workspaces', picker: false, key: 'app' }
  ]
    .map((group) => ({
      ...group,
      items: SECTIONS.filter((item) => groupOf(item) === group.key && matches(item))
    }))
    .filter((group) => group.items.length > 0)

  // Switching the feature off while on its page would leave a page that no longer exists.
  useEffect(() => {
    if (activeHidden) setSection('experimental')
  }, [activeHidden])

  useEffect(() => {
    onPreviewTheme(previewedTheme)
  }, [previewedTheme, onPreviewTheme])

  const patch = (changes: Partial<Settings>): void =>
    setDraft((current) => ({ ...current, ...changes }))

  function save(): void {
    if (dirtyCount === 0) return
    setSaveError('')
    onSave({
      workspaceId: target.editedWorkspaceId,
      workspace: workspaceSettingsFor(draft),
      global: globalSettingsFor(draft)
    }).then(onClose, (error: unknown) =>
      setSaveError(error instanceof Error ? error.message : String(error))
    )
  }

  function discard(): void {
    setDraft((current) => ({
      ...current,
      ...target.savedWorkspaceSettings,
      ...globalSettingsFor(settings)
    }))
  }

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

  /** Put a placeholder where the caret is, replacing any selection, and keep typing from there. */
  function insertPlaceholder(token: string): void {
    const box = bodyRef.current
    if (!selected || !box) return
    const start = box.selectionStart
    const end = box.selectionEnd
    updateTemplate({
      template: selected.template.slice(0, start) + token + selected.template.slice(end)
    })
    const caret = start + token.length
    requestAnimationFrame(() => {
      box.focus()
      box.setSelectionRange(caret, caret)
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
    <Modal bare backdropCloses={false} title="Settings" onClose={onClose} onSubmit={save}>
      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
        <nav className="flex min-h-0 flex-col gap-2.5 overflow-y-auto border-r border-edge bg-chrome/50 px-2.5 py-3">
          <div className="px-1.5">
            <span className="text-[15px] font-semibold tracking-[-0.01em]">Settings</span>
          </div>
          <label className="relative block">
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              className="pointer-events-none absolute left-[9px] top-1/2 -translate-y-1/2 text-faint"
            >
              <circle cx="7" cy="7" r="4.25" />
              <path d="M10.25 10.25 13 13" />
            </svg>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find a setting"
              aria-label="Find a setting"
              className="box-border h-7 w-full rounded-[7px] border border-edge bg-chrome pl-7 pr-2 text-[12.5px] text-ink outline-none placeholder:text-faint focus:border-accent"
            />
          </label>

          {navGroups.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <div className="px-2 pb-1">
                <Eyebrow>{group.label}</Eyebrow>
              </div>
              {group.picker ? (
                <span className="relative mb-1.5 block">
                  <span
                    aria-hidden
                    style={{ backgroundColor: workspaceColor(target.editedWorkspaceId) }}
                    className="pointer-events-none absolute left-[9px] top-1/2 z-10 size-[7px] -translate-y-1/2 rounded-[2px]"
                  />
                  <Select
                    aria-label="Workspace these settings apply to"
                    compact
                    inset
                    className="font-medium"
                    value={target.requestedWorkspaceId ?? target.editedWorkspaceId}
                    onChange={(event) => target.choose(event.target.value)}
                  >
                    {target.workspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name}
                        {workspace.id === settings.activeWorkspaceId ? ' (open)' : ''}
                      </option>
                    ))}
                  </Select>
                </span>
              ) : null}
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-current={item.id === section}
                  onClick={() => setSection(item.id)}
                  className={`flex h-[26px] items-center gap-2 rounded-[7px] px-2 text-left text-[12.5px] transition-colors ${
                    item.id === section
                      ? 'bg-raised font-semibold text-ink'
                      : 'font-medium text-dim hover:bg-raised/70 hover:text-ink'
                  }`}
                >
                  <span className="flex-1">{item.label}</span>
                  {dirtySections.has(item.id) ? (
                    <span
                      title="Unsaved changes"
                      className="size-1.5 rounded-full bg-[var(--color-accent-text)]"
                    />
                  ) : null}
                </button>
              ))}
            </div>
          ))}
          {navGroups.length === 0 ? (
            <p className="px-2 text-[12px] text-faint">No settings match “{search}”.</p>
          ) : null}
        </nav>

        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="flex items-start gap-4 border-b border-edge py-4 pl-6 pr-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-center gap-2.5">
                <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{active.label}</h2>
                <Chip
                  tone={active.scope === 'workspace' ? 'accent' : 'neutral'}
                  title={scopeNoteFor(active.scope, target.editedWorkspaceName)}
                >
                  {active.scope === 'workspace'
                    ? `${target.editedWorkspaceName} only`
                    : 'All workspaces'}
                </Chip>
              </div>
              <p className="text-[12px] leading-normal text-dim text-pretty">{active.blurb}</p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="grid size-7 shrink-0 place-items-center rounded-lg text-dim transition-colors hover:bg-raised/70 hover:text-ink"
            >
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
              </svg>
            </button>
          </header>

          {target.requestedWorkspaceId ? (
            <div
              role="alert"
              className="mx-6 mt-3.5 flex shrink-0 items-center gap-2.5 rounded-[10px] border border-edge-strong bg-raised py-2.5 pl-3.5 pr-2.5"
            >
              <p className="min-w-0 flex-1 text-[12px] leading-[1.45] text-ink">
                You have {dirtyLabel} in {target.editedWorkspaceName}. Switching workspace discards
                them.
              </p>
              <Button autoFocus className="h-[26px] px-2.5" onClick={target.cancelSwitch}>
                Stay
              </Button>
              <Button variant="danger" className="h-[26px] px-2.5" onClick={target.confirmDiscard}>
                Discard &amp; switch
              </Button>
            </div>
          ) : null}
          {target.notice ? (
            <p
              role="status"
              className="mx-6 mt-3.5 shrink-0 rounded-[10px] border border-edge bg-raised/60 px-3.5 py-2.5 text-[12px] text-dim"
            >
              {target.notice}
            </p>
          ) : null}
          {target.editedFileBroken ? (
            <p
              role="status"
              className="mx-6 mt-3.5 shrink-0 rounded-[10px] border border-edge bg-raised/60 px-3.5 py-2.5 text-[12px] text-dim"
            >
              Some of {target.editedWorkspaceName}&apos;s settings.json could not be used, so
              defaults are shown in its place. Saving keeps a copy of the old file as
              settings.json.bak.
            </p>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-5">
            <div
              className={`flex flex-col gap-5 ${section === 'templates' ? 'h-full min-h-[380px]' : 'max-w-[640px]'}`}
            >
              {section === 'preferences' ? (
                <>
                  <div className="flex flex-col gap-2.5">
                    <span className="text-[12px] font-semibold text-dim">New tasks start with</span>
                    <Card>
                      <CardRow>
                        <SwitchRow
                          checked={draft.taskDefaults.useWorktree}
                          onChange={(useWorktree) =>
                            patch({ taskDefaults: { ...draft.taskDefaults, useWorktree } })
                          }
                          label="Own git worktree"
                          hint="Each agent gets a separate checkout on a styr/TASK-… branch, so parallel runs never collide."
                        />
                      </CardRow>
                      <CardRow>
                        <SwitchRow
                          checked={draft.taskDefaults.orchestrate}
                          onChange={(orchestrate) =>
                            patch({ taskDefaults: { ...draft.taskDefaults, orchestrate } })
                          }
                          label="Orchestrate can start it"
                          hint="Orchestrate may pick the task up when a slot is free."
                        />
                      </CardRow>
                    </Card>
                    <Hint>You can still change both on any task.</Hint>
                  </div>
                  <div className="flex flex-col gap-2.5">
                    <span className="text-[12px] font-semibold text-dim">Done column shows</span>
                    <Card>
                      <CardRow>
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3.5 py-3">
                          <span className="flex flex-col gap-[3px]">
                            <span className="text-[12.5px] text-ink">Most recent tasks</span>
                            <Hint>
                              How many finished tasks stay on the board. 0 shows them all.
                            </Hint>
                          </span>
                          <Stepper
                            label="Most recent tasks"
                            value={draft.doneCap.maxCount}
                            min={0}
                            max={1000}
                            onChange={(maxCount) =>
                              patch({ doneCap: { ...draft.doneCap, maxCount } })
                            }
                          />
                        </div>
                      </CardRow>
                      <CardRow>
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3.5 py-3">
                          <span className="flex flex-col gap-[3px]">
                            <span className="text-[12.5px] text-ink">Finished within (days)</span>
                            <Hint>Older tasks are hidden. 0 never hides by age.</Hint>
                          </span>
                          <Stepper
                            label="Finished within (days)"
                            value={draft.doneCap.maxAgeDays}
                            min={0}
                            max={365}
                            onChange={(maxAgeDays) =>
                              patch({ doneCap: { ...draft.doneCap, maxAgeDays } })
                            }
                          />
                        </div>
                      </CardRow>
                    </Card>
                    <Hint>
                      Hidden tasks are not archived — Show all in the Done column brings them back.
                    </Hint>
                  </div>
                  <Field
                    label="Working directory"
                    hint="Where agents run and where + Shell opens. Blank uses the storage folder."
                  >
                    <DirectoryInput
                      value={draft.defaultRepoPath}
                      onChange={(defaultRepoPath) => patch({ defaultRepoPath })}
                      placeholder="Storage folder"
                    />
                  </Field>
                  <Field label="Shell" hint="Every terminal session starts in this shell.">
                    <input
                      className={`${inputBase} h-8 w-60 px-2.5 font-mono text-[11.5px]`}
                      value={draft.shell}
                      onChange={(event) => patch({ shell: event.target.value })}
                    />
                  </Field>
                  <Field
                    label="Open files with"
                    hint="App that opens task files and folders. System default uses whatever macOS has set for the file type."
                  >
                    <OpenWithSelect
                      value={draft.openFilesWith}
                      onChange={(openFilesWith) => patch({ openFilesWith })}
                    />
                  </Field>
                </>
              ) : null}

              {section === 'workspaces' ? (
                <WorkspacesPane
                  workspaces={workspaces}
                  editedWorkspaceId={target.editedWorkspaceId}
                  onEdit={(id) => {
                    target.choose(id)
                    setSection('preferences')
                  }}
                />
              ) : null}

              {section === 'storage' ? (
                <>
                  <Field label="Storage folder">
                    <DirectoryInput
                      value={draft.storageDir}
                      onChange={(storageDir) => patch({ storageDir })}
                    />
                  </Field>
                  <Card className="gap-2 px-3.5 py-3 font-mono text-[11.5px] text-dim">
                    <span>{draft.storageDir}/</span>
                    <span className="pl-4">
                      <span className="text-ink">tasks/*.md</span>
                      <span className="font-[family-name:var(--font-ui)] text-faint">
                        {'  '}— Default workspace
                      </span>
                    </span>
                    <span className="pl-4">
                      <span className="text-ink">workspaces/&lt;name&gt;/</span>
                      <span className="font-[family-name:var(--font-ui)] text-faint">
                        {'  '}— every other workspace
                      </span>
                    </span>
                  </Card>
                  <Hint>
                    This is Styr’s own data, not your code. Point it at a git repo if you want tasks
                    versioned.
                  </Hint>
                </>
              ) : null}

              {section === 'routing' ? (
                <>
                  <Card>
                    <div className="grid grid-cols-[minmax(0,1fr)_24px_200px] items-center gap-2.5 border-b border-edge px-3.5 py-2">
                      <Eyebrow>When a task is</Eyebrow>
                      <span />
                      <Eyebrow>Run this template</Eyebrow>
                    </div>
                    <CardRow className="grid grid-cols-[minmax(0,1fr)_24px_200px] items-center gap-2.5 px-3.5 py-2">
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span>
                          <Chip tone="warn">
                            <svg
                              aria-hidden
                              viewBox="0 0 16 16"
                              width="10"
                              height="10"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinejoin="round"
                              className="mr-1"
                            >
                              <path d="M2.5 3.5v4l6 6 5-5-6-6h-4a1 1 0 0 0-1 1z" />
                              <circle cx="5.5" cy="5.5" r="0.9" fill="currentColor" />
                            </svg>
                            Needs spec
                          </Chip>
                        </span>
                        <span className="text-[11px] text-faint">Any column</span>
                      </span>
                      <RouteArrow />
                      <TemplateSelect
                        label="Template for Needs spec"
                        templates={draft.promptTemplates}
                        value={draft.promptRouting.needsSpec}
                        onChange={(needsSpec) =>
                          patch({ promptRouting: { ...draft.promptRouting, needsSpec } })
                        }
                      />
                    </CardRow>
                    {TASK_STATUSES.map((status) => (
                      <CardRow
                        key={status}
                        className="grid grid-cols-[minmax(0,1fr)_24px_200px] items-center gap-2.5 px-3.5 py-2"
                      >
                        <span className="flex items-center gap-2 text-[12.5px] text-ink">
                          <span
                            className="size-[7px] rounded-full"
                            style={{ backgroundColor: `var(--color-col-${COLUMN_TOKENS[status]})` }}
                          />
                          {TASK_STATUS_LABELS[status]}
                        </span>
                        <RouteArrow />
                        <TemplateSelect
                          label={`Template for ${TASK_STATUS_LABELS[status]}`}
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
                      </CardRow>
                    ))}
                  </Card>
                  <Hint>
                    The Needs spec tag wins over the column, so unspecified work is always specced
                    first. A template pinned on a task overrides all of this.
                  </Hint>
                  <div className="flex flex-col gap-2.5">
                    <Eyebrow>Agent for each lane</Eyebrow>
                    <Card>
                      {ORCHESTRATION_LANES.map((lane) => (
                        <CardRow
                          key={lane}
                          className="grid grid-cols-[minmax(0,1fr)_200px] items-center gap-2.5 px-3.5 py-2"
                        >
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-[12.5px] text-ink">
                              {ORCHESTRATION_LANE_LABELS[lane]}
                            </span>
                            <span className="text-[11px] text-faint">{LANE_HINTS[lane]}</span>
                          </span>
                          <Select
                            compact
                            aria-label={`Agent for ${ORCHESTRATION_LANE_LABELS[lane]}`}
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
                          </Select>
                        </CardRow>
                      ))}
                    </Card>
                    <Hint>
                      Orchestrate uses these providers. Claude remains the default until you opt a
                      lane into Codex. The same choice is in the Orchestrate section.
                    </Hint>
                  </div>
                  <Field
                    label="Fallback template"
                    hint="Used only if a routing entry above points at a template that no longer exists."
                  >
                    <TemplateSelect
                      label="Fallback template"
                      templates={draft.promptTemplates}
                      value={draft.defaultPromptTemplateId}
                      onChange={(defaultPromptTemplateId) => patch({ defaultPromptTemplateId })}
                    />
                  </Field>
                </>
              ) : null}

              {section === 'templates' ? (
                <div className="grid h-full grid-cols-[180px_minmax(0,1fr)] gap-4">
                  <div className="flex flex-col gap-0.5">
                    {draft.promptTemplates.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        aria-current={template.id === selectedId}
                        onClick={() => setSelectedId(template.id)}
                        className={`flex flex-col items-start gap-0.5 rounded-[7px] border px-[9px] py-[7px] text-left transition-colors ${
                          template.id === selectedId
                            ? 'border-edge-strong bg-raised'
                            : 'border-transparent hover:bg-raised/70'
                        }`}
                      >
                        <span className="text-[12.5px] font-medium text-ink">{template.name}</span>
                        <span className="text-[11px] text-faint">
                          {routedTo(draft, template.id)}
                        </span>
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={addTemplate}
                      className="mt-1 inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-dashed border-edge-strong px-[9px] text-[12px] font-medium text-dim transition-colors hover:border-faint hover:text-ink"
                    >
                      <svg
                        aria-hidden
                        viewBox="0 0 16 16"
                        width="12"
                        height="12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      >
                        <path d="M8 3.5v9M3.5 8h9" />
                      </svg>
                      New template
                    </button>
                  </div>

                  {selected ? (
                    <div className="flex min-h-0 min-w-0 flex-col gap-2.5">
                      <div className="flex items-center gap-2">
                        <input
                          aria-label="Template name"
                          className={`${inputBase} h-8 flex-1 px-2.5 text-[13px] font-semibold`}
                          value={selected.name}
                          onChange={(event) => updateTemplate({ name: event.target.value })}
                        />
                        <button
                          type="button"
                          aria-label="Delete template"
                          title="Delete template"
                          onClick={removeTemplate}
                          disabled={draft.promptTemplates.length <= 1}
                          className="grid size-8 shrink-0 place-items-center rounded-[7px] text-danger transition-colors hover:bg-red-500/10 disabled:pointer-events-none disabled:opacity-35"
                        >
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
                            <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
                          </svg>
                        </button>
                      </div>
                      <textarea
                        ref={bodyRef}
                        aria-label="Template body"
                        className={`${inputBase} min-h-40 w-full flex-1 resize-none px-3.5 py-3 font-mono text-[12px] leading-[1.65]`}
                        value={selected.template}
                        onChange={(event) => updateTemplate({ template: event.target.value })}
                      />
                      <div className="flex flex-col gap-1.5">
                        <Hint>
                          Click to insert. The board protocol and context files are added
                          automatically if you leave them out.
                        </Hint>
                        <div className="flex flex-wrap gap-1">
                          {PLACEHOLDERS.map((token) => (
                            <button
                              key={token}
                              type="button"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => insertPlaceholder(token)}
                              className="h-5 rounded-[5px] bg-raised px-1.5 font-mono text-[10.5px] text-dim transition-colors hover:bg-edge-strong hover:text-ink"
                            >
                              {token}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {section === 'orchestration' ? (
                <>
                  <Card>
                    <div className="grid grid-cols-[minmax(0,1fr)_150px_104px] items-center gap-3 border-b border-edge px-3.5 py-2">
                      <Eyebrow>Lane</Eyebrow>
                      <Eyebrow>Agent</Eyebrow>
                      <span className="text-center">
                        <Eyebrow>At once</Eyebrow>
                      </span>
                    </div>
                    {ORCHESTRATION_LANES.map((lane) => (
                      <CardRow
                        key={lane}
                        className={`grid grid-cols-[minmax(0,1fr)_150px_104px] items-center gap-3 px-3.5 py-2.5 ${
                          draft.orchestration[lane] === 0 ? 'opacity-60' : ''
                        }`}
                      >
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-[12.5px] font-medium text-ink">
                            {ORCHESTRATION_LANE_LABELS[lane]}
                          </span>
                          <span className="text-[11px] text-faint">
                            {draft.orchestration[lane] === 0
                              ? 'Skipped — Orchestrate leaves these alone'
                              : LANE_HINTS[lane]}
                          </span>
                        </span>
                        <Select
                          compact
                          aria-label={`Agent for ${ORCHESTRATION_LANE_LABELS[lane]}`}
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
                        </Select>
                        <Stepper
                          label={ORCHESTRATION_LANE_LABELS[lane]}
                          value={draft.orchestration[lane]}
                          min={0}
                          max={20}
                          onChange={(value) =>
                            patch({ orchestration: { ...draft.orchestration, [lane]: value } })
                          }
                        />
                      </CardRow>
                    ))}
                  </Card>
                  <Hint>
                    Orchestrate fills free slots with the highest-priority waiting task. A slot is
                    busy while its session is live. Set a lane to 0 to skip it. Up to{' '}
                    {ORCHESTRATION_LANES.reduce((sum, lane) => sum + draft.orchestration[lane], 0)}{' '}
                    agents can run at once.
                  </Hint>
                </>
              ) : null}

              {section === 'shortcuts' ? (
                <>
                  <Card>
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
                  </Card>

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

                  <Hint>
                    Click Change and press the new keys. Esc closes a dialog and ⌘↵ saves one; both
                    are fixed. Ctrl+C, Ctrl+D, Ctrl+L, Ctrl+Z, Esc, Enter and Tab cannot be bound —
                    the terminal needs them.
                  </Hint>
                </>
              ) : null}
              {section === 'theme' ? (
                <>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center">
                      <span className="text-[12px] font-semibold text-dim">Theme</span>
                      <button
                        type="button"
                        className="ml-auto h-[22px] rounded-md px-1.5 text-[11.5px] text-faint transition-colors hover:text-ink"
                        onClick={() => patch({ theme: DEFAULT_THEME })}
                      >
                        Reset theme
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {THEME_PRESETS.map((preset) => {
                        const on = draft.theme.base.toLowerCase() === preset.base
                        return (
                          <button
                            key={preset.label}
                            type="button"
                            aria-pressed={on}
                            onClick={() => patch({ theme: applyPreset(draft.theme, preset) })}
                            className="flex flex-col items-center gap-[5px]"
                          >
                            <span
                              style={{ backgroundColor: preset.base }}
                              className={`flex h-[34px] w-[52px] items-end gap-[3px] rounded-lg border-2 p-1 shadow-[inset_0_0_0_1px_rgba(128,128,128,0.25)] ${
                                on ? 'border-[var(--color-accent-text)]' : 'border-transparent'
                              }`}
                            >
                              <span
                                style={{ backgroundColor: preset.accent }}
                                className="h-2 w-3 rounded-sm"
                              />
                              {Object.values(preset.columns).map((hex) => (
                                <span
                                  key={hex}
                                  style={{ backgroundColor: hex }}
                                  className="h-2 w-[5px] rounded-sm"
                                />
                              ))}
                            </span>
                            <span className={`text-[11px] ${on ? 'text-ink' : 'text-faint'}`}>
                              {preset.label}
                            </span>
                          </button>
                        )
                      })}
                      <ColorPopover
                        value={draft.theme.base}
                        onChange={(base) => patch({ theme: { ...draft.theme, base } })}
                        trigger={({ open, toggle }) => {
                          const custom = !THEME_PRESETS.some(
                            (preset) => preset.base === draft.theme.base.toLowerCase()
                          )
                          return (
                            <button
                              type="button"
                              aria-label="Custom base colour"
                              aria-expanded={open}
                              onClick={toggle}
                              className="flex flex-col items-center gap-[5px]"
                            >
                              <span
                                style={custom ? { backgroundColor: draft.theme.base } : undefined}
                                className={`grid h-[34px] w-[52px] place-items-center rounded-lg border-2 text-[15px] text-dim shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] ${
                                  custom
                                    ? 'border-[var(--color-accent-text)]'
                                    : 'border-dashed border-edge-strong'
                                }`}
                              >
                                {custom ? null : '+'}
                              </span>
                              <span className={`text-[11px] ${custom ? 'text-ink' : 'text-faint'}`}>
                                Custom
                              </span>
                            </button>
                          )
                        }}
                      />
                    </div>
                    <Hint>
                      A theme sets the base, accent and column colours together. Every surface and
                      text colour is derived from the base, so contrast holds; change any colour
                      below to make it your own.
                    </Hint>
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="text-[12px] font-semibold text-dim">Accent and columns</span>
                    <div className="grid grid-cols-5 gap-2">
                      <ColorSwatch
                        label="Accent"
                        value={draft.theme.accent}
                        onChange={(accent) => patch({ theme: { ...draft.theme, accent } })}
                      />
                      {TASK_STATUSES.map((status, index) => (
                        <ColorSwatch
                          key={status}
                          label={TASK_STATUS_LABELS[status]}
                          value={draft.theme.columns[status]}
                          align={index >= 2 ? 'end' : 'start'}
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
                    <Hint>
                      Column colours also tint agent states: In Progress is Working, In Review is
                      Waiting on you, Done is Finished.
                    </Hint>
                  </div>

                  <div className="flex flex-col gap-2.5">
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
                      <span className="flex flex-col gap-0.5">
                        <span className="text-[12.5px] text-ink">Gradient background</span>
                        <Hint>Washes the base with a hint of the accent.</Hint>
                      </span>
                      <Switch
                        label="Gradient background"
                        checked={draft.theme.gradient}
                        onChange={(gradient) => patch({ theme: { ...draft.theme, gradient } })}
                      />
                    </div>
                    {draft.theme.gradient ? (
                      <div className="flex flex-col gap-2 pl-0.5">
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

                  <div className="h-px bg-edge" />

                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_104px] gap-3">
                    <Field label="Interface font">
                      <Select
                        compact
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
                    <Field label="Terminal font">
                      <Select
                        compact
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
                      <Stepper
                        label="Terminal font size"
                        className="h-[30px]"
                        value={draft.theme.terminalFontSize}
                        min={9}
                        max={24}
                        onChange={(terminalFontSize) =>
                          patch({ theme: { ...draft.theme, terminalFontSize } })
                        }
                      />
                    </Field>
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="text-[12px] font-semibold text-dim">Terminal colours</span>
                    <div className="flex flex-wrap gap-1.5">
                      {TERMINAL_PALETTES.map((preset) => {
                        const on = samePalette(draft.theme.terminalPalette, preset.palette)
                        return (
                          <button
                            key={preset.label}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              patch({ theme: { ...draft.theme, terminalPalette: preset.palette } })
                            }
                            className={`inline-flex h-7 items-center gap-2 rounded-[7px] border px-2.5 text-[12px] transition-colors ${
                              on
                                ? 'border-accent bg-accent/15 text-ink'
                                : 'border-edge-strong text-dim hover:text-ink'
                            }`}
                          >
                            <span className="flex overflow-hidden rounded-[3px]">
                              {PREVIEW_SLOTS.map((slot) => (
                                <span
                                  key={slot}
                                  style={{ backgroundColor: preset.palette[slot] }}
                                  className="h-2.5 w-2"
                                />
                              ))}
                            </span>
                            {preset.label}
                          </button>
                        )
                      })}
                    </div>

                    <div
                      className="rounded-[10px] border border-edge-strong px-3.5 py-3 font-mono leading-[1.65]"
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
                    <Hint>
                      Background, text and cursor follow the base. These are what git, agents and
                      your prompt draw with.
                    </Hint>

                    <button
                      type="button"
                      aria-expanded={editingAnsi}
                      onClick={() => setEditingAnsi((current) => !current)}
                      className="self-start text-[11.5px] text-faint transition-colors hover:text-ink"
                    >
                      {editingAnsi ? 'Hide individual colours' : 'Edit individual colours'}
                    </button>
                    {editingAnsi ? (
                      <Card className="gap-3 p-3">
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
                                  ? 'border-[var(--color-accent-text)]'
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
                      </Card>
                    ) : null}
                  </div>
                </>
              ) : null}

              {section === 'source-github' ? (
                <SourcesPane
                  sources={draft.sources}
                  saved={target.savedWorkspaceSettings.sources}
                  canAct={target.editingActiveWorkspace}
                  onChange={(sources) => patch({ sources })}
                />
              ) : null}

              {section === 'agents' ? (
                <>
                  {(
                    [
                      { id: 'claude', label: 'Claude Code', command: draft.claudeCommand },
                      { id: 'codex', label: 'Codex', command: draft.codexCommand }
                    ] as const
                  ).map((provider) => {
                    const on = draft.enabledProviders.includes(provider.id)
                    const only = on && draft.enabledProviders.length === 1
                    const isDefault = on && draft.defaultProvider === provider.id
                    const mcp = provider.id === 'claude' ? mcpCommand : codexMcpCommand
                    return (
                      <Card key={provider.id}>
                        <div className="flex items-center gap-3 px-3.5 py-3">
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                              {provider.label}
                              {isDefault ? <Chip tone="accent">Default</Chip> : null}
                            </span>
                            <span className="text-[11.5px] text-faint">
                              {!on
                                ? 'Off. Tasks and lanes cannot use it.'
                                : isDefault
                                  ? 'Used by manual launches. Orchestrate lanes can pick either.'
                                  : 'Available for tasks and Orchestrate lanes.'}
                            </span>
                          </span>
                          {on && !isDefault ? (
                            <Button
                              variant="subtle"
                              onClick={() => patch({ defaultProvider: provider.id })}
                            >
                              Make default
                            </Button>
                          ) : null}
                          <Switch
                            label={`Enable ${provider.label}`}
                            checked={on}
                            disabled={only}
                            title={only ? 'At least one provider must stay on' : undefined}
                            onChange={(enabled) => toggleProvider(provider.id, enabled)}
                          />
                        </div>

                        {on ? (
                          <div className="flex flex-col gap-3 border-t border-edge px-3.5 pb-3.5 pt-3">
                            <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2.5">
                              <span className="text-[12px] text-dim">Command</span>
                              <input
                                aria-label={`${provider.label} command`}
                                className={`${inputBase} h-7 w-full max-w-[260px] px-2.5 font-mono text-[11.5px]`}
                                value={provider.command}
                                onChange={(event) =>
                                  patch(
                                    provider.id === 'claude'
                                      ? { claudeCommand: event.target.value }
                                      : { codexCommand: event.target.value }
                                  )
                                }
                              />
                            </div>

                            {provider.id === 'claude' ? (
                              <div className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-2.5">
                                <span className="pt-[5px] text-[12px] text-dim">Approvals</span>
                                <div className="flex flex-col gap-1.5">
                                  <Segmented
                                    label="Claude approvals"
                                    value={draft.claudeApprovalMode}
                                    onChange={(claudeApprovalMode) => patch({ claudeApprovalMode })}
                                    options={[
                                      { value: 'user', label: 'Ask me' },
                                      { value: 'auto', label: 'Approve for me' }
                                    ]}
                                  />
                                  <Hint>
                                    {draft.claudeApprovalMode === 'user'
                                      ? 'Claude Code pauses and asks before risky actions.'
                                      : 'Permission prompts go to Claude Code’s auto mode classifier; it does not grant full access. Needs a recent Claude Code.'}
                                  </Hint>
                                </div>
                              </div>
                            ) : null}

                            {provider.id === 'codex' ? (
                              <div className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-2.5">
                                <span className="pt-[5px] text-[12px] text-dim">Approvals</span>
                                <div className="flex flex-col gap-1.5">
                                  <Segmented
                                    label="Codex approvals"
                                    value={draft.codexApprovalReviewer}
                                    onChange={(codexApprovalReviewer) =>
                                      patch({ codexApprovalReviewer })
                                    }
                                    options={[
                                      { value: 'user', label: 'Ask me' },
                                      { value: 'auto_review', label: 'Approve for me' }
                                    ]}
                                  />
                                  <Hint>
                                    {draft.codexApprovalReviewer === 'user'
                                      ? 'Codex pauses and asks before risky commands.'
                                      : 'Eligible requests go to Codex’s automatic reviewer; it does not grant full access.'}{' '}
                                    Codex runs in the workspace-write sandbox with network access,
                                    so it can push and use `gh`.
                                  </Hint>
                                </div>
                              </div>
                            ) : null}

                            <div className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-2.5">
                              <span className="pt-1.5 text-[12px] text-dim">Board access</span>
                              <div className="flex min-w-0 flex-col gap-1.5">
                                <div className="flex min-w-0 items-center gap-1.5 rounded-[7px] border border-edge bg-surface py-1 pl-2.5 pr-1">
                                  <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim">
                                    {mcp || 'Building command…'}
                                  </code>
                                  <Button
                                    className="h-6 shrink-0 px-2 text-[11.5px]"
                                    disabled={!mcp}
                                    onClick={() => {
                                      void navigator.clipboard.writeText(mcp).then(() => {
                                        setCopied(provider.id)
                                        setTimeout(() => setCopied(null), 1600)
                                      })
                                    }}
                                  >
                                    {copied === provider.id ? 'Copied' : 'Copy'}
                                  </Button>
                                </div>
                                <Hint>
                                  Run once in a terminal, then start a new {provider.label} session.
                                  It lets the agent read and move tasks on the board from anywhere.
                                  Registered once for every workspace, built from the active
                                  workspace’s command.
                                </Hint>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </Card>
                    )
                  })}
                </>
              ) : null}
              {section === 'experimental' ? (
                <>
                  <Card>
                    <SwitchRow
                      label="External sources"
                      hint="Link GitHub issues to tasks. Adds a GitHub page under Integrations. Off, nothing is read from or written to GitHub."
                      checked={draft.experimental.externalSources}
                      onChange={(externalSources) =>
                        patch({ experimental: { ...draft.experimental, externalSources } })
                      }
                    />
                  </Card>
                  <Hint>Experimental features can change or disappear between releases.</Hint>
                </>
              ) : null}

              {section === 'updates' ? (
                <>
                  <Card className="flex-row items-center gap-3.5 p-3.5">
                    <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                      <span className="text-[13px] font-semibold text-ink">
                        Styr {version || '…'}
                      </span>
                      <span
                        className={`text-[12px] ${update?.kind === 'error' ? 'text-danger' : 'text-dim'}`}
                      >
                        {describeUpdate(update)}
                      </span>
                    </span>
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
                  </Card>
                  <Card>
                    <SwitchRow
                      checked={draft.updates.checkAutomatically}
                      onChange={(checkAutomatically) => patch({ updates: { checkAutomatically } })}
                      label="Check for updates automatically"
                      hint="When Styr opens and every few hours after. An update downloads in the background and installs the next time you quit, so running agents are never interrupted."
                    />
                  </Card>
                </>
              ) : null}
            </div>
          </div>

          <footer className="flex shrink-0 items-center gap-2 border-t border-edge bg-chrome/40 py-3 pl-6 pr-4">
            {saveError ? (
              <span role="alert" className="text-[12px] text-danger">
                {saveError}
              </span>
            ) : (
              <span
                className={`flex items-center gap-[7px] text-[12px] ${dirtyCount ? 'text-ink' : 'text-faint'}`}
              >
                {dirtyCount ? (
                  <span className="size-1.5 rounded-full bg-[var(--color-accent-text)]" />
                ) : null}
                {dirtyCount === 0
                  ? 'All changes saved'
                  : `${dirtyLabel} in ${target.editedWorkspaceName}`}
              </span>
            )}
            <div className="flex-1" />
            {dirtyCount ? (
              <Button variant="subtle" onClick={discard}>
                Discard
              </Button>
            ) : null}
            <Button variant="primary" disabled={dirtyCount === 0} onClick={save}>
              Save
              <kbd className="font-mono text-[10px] font-normal opacity-70">⌘↵</kbd>
            </Button>
          </footer>
        </section>
      </div>
    </Modal>
  )
}
