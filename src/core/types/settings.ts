import type { SourceConfig } from '../sources/types.js'
import type { ThemeSettings } from '../types.js'
import type {
  OrchestrationCapacity,
  OrchestrationLane,
  PromptRouting,
  PromptTemplate
} from './agents.js'
import type { DoneCap, TaskDefaults, TaskPreset } from './task.js'

export const SHORTCUT_COMMANDS = [
  'newTask',
  'quickTask',
  'quickOpen',
  'commandPalette',
  'viewBoard',
  'viewInbox',
  'settings',
  'toggleTerminal',
  'toggleAgents',
  'orchestrate',
  'toggleAutoDispatch',
  'newShell',
  'closeShell',
  'switchWorkspace',
  'newWorkspace',
  'terminalDirectory',
  'terminalAskAgent',
  'terminalCopyOutput',
  'terminalRetry',
  'terminalSplit',
  'terminalAskReview',
  'terminalHandOff',
  'terminalCreatePr',
  'terminalTab1',
  'terminalTab2',
  'terminalTab3',
  'terminalTab4',
  'terminalTab5',
  'terminalTab6',
  'terminalTab7',
  'terminalTab8',
  'terminalTab9'
] as const

export type ShortcutCommand = (typeof SHORTCUT_COMMANDS)[number]

/**
 * Accelerators per command. A list rather than one string so a command can keep an alternate —
 * the terminal panel answers to both Ctrl+` and Cmd+` — and so unbinding is an empty list rather
 * than a sentinel string.
 */
export type ShortcutBindings = Record<ShortcutCommand, string[]>

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  newTask: ['mod+n'],
  quickTask: ['mod+shift+n'],
  quickOpen: ['mod+p', 'mod+f'],
  commandPalette: ['mod+shift+p', 'mod+k'],
  viewBoard: ['ctrl+1'],
  viewInbox: ['ctrl+2'],
  settings: ['mod+,'],
  toggleTerminal: ['ctrl+`', 'mod+`'],
  toggleAgents: [],
  orchestrate: [],
  toggleAutoDispatch: [],
  newShell: ['mod+t'],
  closeShell: ['mod+w'],
  switchWorkspace: [],
  newWorkspace: [],
  terminalDirectory: ['mod+o'],
  terminalAskAgent: ['mod+l'],
  terminalCopyOutput: ['mod+shift+c'],
  terminalRetry: ['mod+r'],
  terminalSplit: ['mod+d'],
  terminalAskReview: [],
  terminalHandOff: [],
  terminalCreatePr: [],
  terminalTab1: ['mod+1'],
  terminalTab2: ['mod+2'],
  terminalTab3: ['mod+3'],
  terminalTab4: ['mod+4'],
  terminalTab5: ['mod+5'],
  terminalTab6: ['mod+6'],
  terminalTab7: ['mod+7'],
  terminalTab8: ['mod+8'],
  terminalTab9: ['mod+9']
}

export interface Settings {
  /** Where the app keeps its own data. Workspaces live inside it; the default one is its root. */
  storageDir: string
  /** Which workspace the board shows. A local preference, never stored in the task files. */
  activeWorkspaceId: string
  defaultRepoPath: string
  shell: string
  /** App that opens files from Styr (task files, folders). Empty uses the system default. */
  openFilesWith: string
  claudeCommand: string
  claudeApprovalMode: 'user' | 'auto'
  codexCommand: string
  codexApprovalReviewer: 'user' | 'auto_review'
  enabledProviders: ('claude' | 'codex')[]
  defaultProvider: 'claude' | 'codex'
  providerRouting: Record<OrchestrationLane, 'claude' | 'codex'>
  defaultPromptTemplateId: string
  promptTemplates: PromptTemplate[]
  promptRouting: PromptRouting
  orchestration: OrchestrationCapacity
  /** Auto-run: keep starting eligible work as slots free up. Off until the user turns it on. */
  autoDispatch: boolean
  theme: ThemeSettings
  shortcuts: ShortcutBindings
  updates: UpdateSettings
  experimental: ExperimentalSettings
  taskDefaults: TaskDefaults
  taskPresets: TaskPreset[]
  doneCap: DoneCap
  sources: SourceConfig[]
}

/**
 * The settings that belong to the app rather than to a board. They live in `~/.styr/config.json`.
 */
export const GLOBAL_SETTING_KEYS = [
  'storageDir',
  'activeWorkspaceId',
  'updates',
  'shortcuts',
  'experimental'
] as const satisfies readonly (keyof Settings)[]

/**
 * The settings each workspace keeps in its own `settings.json`. Every `Settings` key is in exactly
 * one of the two lists, and a test holds the schema to that, so a new key needs a deliberate choice.
 */
export const WORKSPACE_SETTING_KEYS = [
  'defaultRepoPath',
  'shell',
  'openFilesWith',
  'claudeCommand',
  'claudeApprovalMode',
  'codexCommand',
  'codexApprovalReviewer',
  'enabledProviders',
  'defaultProvider',
  'providerRouting',
  'defaultPromptTemplateId',
  'promptTemplates',
  'promptRouting',
  'orchestration',
  'autoDispatch',
  'theme',
  'taskDefaults',
  'taskPresets',
  'doneCap',
  'sources'
] as const satisfies readonly (keyof Settings)[]

export type GlobalSettingKey = (typeof GLOBAL_SETTING_KEYS)[number]
export type WorkspaceSettingKey = (typeof WORKSPACE_SETTING_KEYS)[number]
export type GlobalSettings = Pick<Settings, GlobalSettingKey>
export type WorkspaceSettings = Pick<Settings, WorkspaceSettingKey>

export function isWorkspaceSettingKey(key: string): key is WorkspaceSettingKey {
  return (WORKSPACE_SETTING_KEYS as readonly string[]).includes(key)
}

function pickSettings<K extends keyof Settings>(
  settings: Settings,
  keys: readonly K[]
): Pick<Settings, K> {
  return Object.fromEntries(keys.map((key) => [key, settings[key]])) as Pick<Settings, K>
}

export function globalSettingsFor(settings: Settings): GlobalSettings {
  return pickSettings(settings, GLOBAL_SETTING_KEYS)
}

export function workspaceSettingsFor(settings: Settings): WorkspaceSettings {
  return pickSettings(settings, WORKSPACE_SETTING_KEYS)
}

/** One Save from the Settings dialog: the app-level keys, and one workspace's own. */
export interface SettingsChange {
  workspaceId: string
  workspace: WorkspaceSettings
  global: GlobalSettings
}

/** A workspace whose `settings.json` exists but could not be read, so it is running on defaults. */
export interface BrokenSettingsFile {
  workspaceId: string
  path: string
}

/** Features still being tried out. Each is off until switched on in Settings → Experimental. */
export interface ExperimentalSettings {
  /** External sources (GitHub issues) under Settings → Integrations. */
  externalSources: boolean
  /**
   * Styr Terminal, the native terminal engine, in place of xterm.js. Only takes effect where the
   * engine is bundled and loads; anywhere else terminals stay on xterm.js.
   */
  nativeTerminal: boolean
}

export interface UpdateSettings {
  /** Check when the app opens and every few hours after. A manual check works either way. */
  checkAutomatically: boolean
}

/**
 * What the updater is doing, mirrored from the main process to the renderer. An available update
 * is downloaded straight away, so there is no separate "available" state: it goes to downloading.
 */
export type UpdateState =
  | { kind: 'unsupported' }
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; checkedAt: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string }

export interface AppInfo {
  isPackaged: boolean
  version: string
}
