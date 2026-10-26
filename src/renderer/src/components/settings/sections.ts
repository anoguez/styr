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
    label: 'Tasks',
    scope: 'workspace',
    sub: 'Board',
    blurb:
      'Defaults for new tasks, and what the board keeps in view. Existing tasks keep their own settings.',
    keys: ['taskDefaults', 'doneCap', 'autoArchiveAsk', 'remoteAccess'],
    words:
      'remote access share phone device done cap archive ask agent chats hide limit worktree dispatch orchestrate default general preferences new task'
  },
  {
    id: 'agents',
    label: 'Agents',
    scope: 'workspace',
    sub: 'Agents',
    blurb:
      'The coding CLIs Styr can launch, the models they offer, and how they ask for permission.',
    keys: [
      'enabledProviders',
      'defaultProvider',
      'agentModels',
      'claudeCommand',
      'claudeApprovalMode',
      'codexCommand',
      'codexApprovalReviewer'
    ],
    words: 'claude codex provider mcp command approvals agents model models opus sonnet'
  },
  {
    id: 'presets',
    label: 'Presets',
    scope: 'workspace',
    sub: 'Board',
    blurb:
      'Starting points for the New task dialog. A task keeps no link to the preset it came from.',
    keys: ['taskPresets'],
    words: 'task template preset bug refactor spec new task prefill'
  },
  {
    id: 'source-github',
    label: 'GitHub',
    scope: 'workspace',
    sub: 'Board',
    blurb: 'Link GitHub issues to tasks. Read-only sources are never written to.',
    keys: ['sources'],
    provider: 'github',
    flag: 'externalSources',
    words: 'github issues sync gh external source'
  },
  {
    id: 'source-rest',
    label: 'REST API',
    scope: 'workspace',
    sub: 'Board',
    blurb: 'Import the items REST endpoints return as tasks. Styr only reads from them.',
    // `sources` is claimed by the GitHub page; this one is judged by its own entries in it
    keys: [],
    provider: 'rest',
    flag: 'externalSources',
    words: 'rest api http endpoint request headers body json sync external source'
  },
  {
    id: 'routing',
    label: 'Prompt routing',
    scope: 'workspace',
    sub: 'Agents',
    blurb: 'Which template runs when you press Start, based on where the task sits.',
    keys: ['promptRouting', 'defaultPromptTemplateId', 'providerRouting'],
    words: 'template column spec fallback agent lane'
  },
  {
    id: 'templates',
    label: 'Templates',
    scope: 'workspace',
    sub: 'Agents',
    blurb: 'The prompts agents receive. Placeholders are filled from the task.',
    keys: ['promptTemplates'],
    words: 'prompt placeholder body'
  },
  {
    id: 'orchestration',
    label: 'Dispatch',
    scope: 'workspace',
    sub: 'Agents',
    blurb:
      'Which agent picks up each kind of work, how many run at once, and when Auto-run stops itself.',
    keys: ['orchestration', 'autoDispatchLimits'],
    words: 'slots lanes parallel concurrency limits breaker safety auto-run orchestrate agent lane'
  },
  {
    id: 'environment',
    label: 'Folders & terminal',
    scope: 'workspace',
    sub: 'Environment',
    blurb: 'Where agents work, which shell they get, and how files open.',
    keys: ['defaultRepoPath', 'worktreeLocation', 'shell', 'restoreTabs', 'openFilesWith'],
    words:
      'working directory worktree location node_modules shell terminal tabs restore open files editor app'
  },
  {
    id: 'theme',
    label: 'Theme',
    scope: 'workspace',
    sub: 'Board',
    blurb: 'Colours and fonts. Changes preview live while this workspace is open.',
    keys: ['theme'],
    words: 'colour color font gradient terminal palette appearance'
  },
  {
    id: 'workspaces',
    label: 'Workspaces',
    scope: 'app',
    live: true,
    blurb: 'Separate boards, each with its own tasks, agents and settings.',
    keys: [],
    words: 'board'
  },
  {
    id: 'remote-access',
    label: 'Remote access',
    scope: 'app',
    live: true,
    blurb:
      'Let devices you pair, such as a phone, use the workspaces you share. Reached over a private network only.',
    // These controls act at once, like Remote hosts: nothing here waits for Save.
    keys: [],
    words:
      'remote access phone mobile device pair qr tailscale network listen port token revoke awake sleep flutter app'
  },
  {
    id: 'remote',
    label: 'Remote hosts',
    scope: 'app',
    live: true,
    blurb: 'Machines that run your remote workspaces. Your local workspaces are not affected.',
    keys: [],
    flag: 'remoteWorkspaces',
    words:
      'remote ssh host server tailscale vm cloud serve connection upgrade stop disconnect uptime version set up new workspace'
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
    words: 'beta preview labs flags features github sources terminal engine native styr'
  }
] as const satisfies readonly {
  id: string
  label: string
  /** The sub-heading a workspace page sits under in the nav. */
  sub?: 'Board' | 'Agents' | 'Environment'
  /** Nothing on the page waits for Save: its controls act at once. */
  live?: true
  /** An Integrations page edits only this provider's entries of `sources`. */
  provider?: string
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
  const sourceOf = (settings: Settings, provider: string): string =>
    JSON.stringify(settings.sources.filter((source) => source.provider === provider))
  const sectionChanged = (item: Section): boolean =>
    'provider' in item
      ? sourceOf(draft, item.provider) !== sourceOf(baseline, item.provider)
      : item.keys.some(isChanged)
  return {
    sections: new Set(SECTIONS.filter(sectionChanged).map((item) => item.id)),
    count: SECTIONS.reduce((count, item) => count + item.keys.filter(isChanged).length, 0)
  }
}

const NAV_GROUPS = [
  { label: 'Workspace', picker: true, scope: 'workspace' },
  { label: 'All workspaces', picker: false, scope: 'app' }
] as const

const NAV_SUBS = ['Board', 'Agents', 'Environment'] as const

export interface NavSub {
  /** Empty for the app-level group, which has no sub-headings. */
  label: string
  items: Section[]
}

export interface NavGroup {
  label: string
  /** The group headed by the workspace picker. */
  picker: boolean
  subs: NavSub[]
}

/** The nav: shown sections matching the search box, under their group; empty groups drop out. */
export function settingsNav(search: string, experimental: ExperimentalSettings): NavGroup[] {
  const query = search.trim().toLowerCase()
  const matches = (item: Section): boolean =>
    sectionShown(item, experimental) &&
    (!query || `${item.label} ${item.words}`.toLowerCase().includes(query))
  return NAV_GROUPS.map(({ label, picker, scope }) => {
    const inScope = SECTIONS.filter((item) => item.scope === scope && matches(item))
    const subs: NavSub[] =
      scope === 'app'
        ? [{ label: '', items: inScope }]
        : NAV_SUBS.map((sub) => ({
            label: sub,
            items: inScope.filter((item) => 'sub' in item && item.sub === sub)
          }))
    return { label, picker, subs: subs.filter((sub) => sub.items.length > 0) }
  }).filter((group) => group.subs.length > 0)
}
