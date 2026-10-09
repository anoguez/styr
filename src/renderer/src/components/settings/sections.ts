import type { ExperimentalSettings, Settings } from '@core/types.js'

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
    id: 'presets',
    label: 'Presets',
    scope: 'workspace',
    blurb:
      'Starting points for the New task dialog. A task keeps no link to the preset it came from.',
    keys: ['taskPresets'],
    words: 'task template preset bug refactor spec new task prefill'
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
    label: 'Dispatch',
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

export type SectionId = (typeof SECTIONS)[number]['id']

export type Section = (typeof SECTIONS)[number]
type SectionScope = Section['scope']

/** What a section pane edits: the dialog's draft and a way to change part of it. */
export interface SectionProps {
  draft: Settings
  patch: (changes: Partial<Settings>) => void
}

/** Where a section's values are stored and which workspaces they reach. */
export function scopeNoteFor(scope: SectionScope, workspaceName: string): string {
  return scope === 'app'
    ? 'Stored in ~/.styr/config.json and shared by every workspace.'
    : `Stored in the ${workspaceName} workspace folder and applies to it only.`
}

/** A section behind an experimental flag shows only while the flag is on. */
export function sectionShown(section: Section, experimental: ExperimentalSettings): boolean {
  return !('flag' in section) || experimental[section.flag]
}

/**
 * Unsaved changes, judged per `Settings` key over each section's `keys`: which sections have any,
 * and how many keys differ in all.
 */
export function unsavedChanges(
  draft: Settings,
  baseline: Settings
): { sections: ReadonlySet<SectionId>; count: number } {
  const isChanged = (key: keyof Settings): boolean =>
    JSON.stringify(draft[key]) !== JSON.stringify(baseline[key])
  return {
    sections: new Set(SECTIONS.filter((item) => item.keys.some(isChanged)).map((item) => item.id)),
    count: SECTIONS.reduce((count, item) => count + item.keys.filter(isChanged).length, 0)
  }
}

const NAV_GROUPS = [
  { label: 'Workspace', picker: true, key: 'workspace' },
  { label: 'Integrations', picker: false, key: 'integrations' },
  { label: 'All workspaces', picker: false, key: 'app' }
] as const

export interface NavGroup {
  label: string
  /** The group headed by the workspace picker. */
  picker: boolean
  items: Section[]
}

/** The nav: shown sections matching the search box, under their group; empty groups drop out. */
export function settingsNav(search: string, experimental: ExperimentalSettings): NavGroup[] {
  const query = search.trim().toLowerCase()
  const matches = (item: Section): boolean =>
    sectionShown(item, experimental) &&
    (!query || `${item.label} ${item.words}`.toLowerCase().includes(query))
  const groupOf = (item: Section): string => ('group' in item ? item.group : item.scope)
  return NAV_GROUPS.map(({ label, picker, key }) => ({
    label,
    picker,
    items: SECTIONS.filter((item) => groupOf(item) === key && matches(item))
  })).filter((group) => group.items.length > 0)
}
