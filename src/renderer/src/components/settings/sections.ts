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
