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
  'viewWorklog',
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
  'terminalFixLast',
  'terminalHandOff',
  'terminalCreatePr',
  'terminalActivity',
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
 * What the tray menu asks the window to do (`app:command`). Stopping Auto-run is its own command
 * rather than `toggleAutoDispatch`: a window that has just loaded does not know Auto-run is on yet,
 * and the toggle would start it instead of asking to stop it.
 */
export type TrayCommand = 'quickTask' | 'viewInbox' | 'stopAutoRun'

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
  viewWorklog: ['ctrl+3'],
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
  terminalFixLast: [],
  terminalHandOff: [],
  terminalCreatePr: [],
  terminalActivity: ['mod+shift+a'],
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

/**
 * Where new task worktrees are created. `beside` puts them next to the repository
 * (`<repo>.worktrees/<key>`); `inside` puts them in `<repo>/.styr/worktrees/<key>`, so tools that
 * walk up the tree (Node's `node_modules` lookup) find the main checkout's installed dependencies.
 */
export type WorktreeLocation = 'beside' | 'inside'

/** `ask` offers the last session's tabs in a banner; `always` reopens them; `never` saves nothing. */
export type RestoreTabsMode = 'ask' | 'always' | 'never'

export const RESTORE_TABS_MODES: readonly RestoreTabsMode[] = ['ask', 'always', 'never']

export interface Settings {
  /** Where the app keeps its own data. Workspaces live inside it; the default one is its root. */
  storageDir: string
  /** Which workspace the board shows. A local preference, never stored in the task files. */
  activeWorkspaceId: string
  defaultRepoPath: string
  shell: string
  /** App that opens files from Styr (task files, folders). Empty uses the system default. */
  openFilesWith: string
  /** Applies to worktrees created from now on; an existing one stays where it was made. */
  worktreeLocation: WorktreeLocation
  claudeCommand: string
  claudeApprovalMode: 'user' | 'auto'
  codexCommand: string
  codexApprovalReviewer: 'user' | 'auto_review'
  enabledProviders: ('claude' | 'codex')[]
  defaultProvider: 'claude' | 'codex'
  /**
   * The models registered for each CLI in Settings → Agents, as that CLI names them. Templates and
   * tasks pick from these; with none picked the CLI runs its own default.
   */
  agentModels: Record<'claude' | 'codex', string[]>
  providerRouting: Record<OrchestrationLane, 'claude' | 'codex'>
  defaultPromptTemplateId: string
  promptTemplates: PromptTemplate[]
  promptRouting: PromptRouting
  orchestration: OrchestrationCapacity
  /** Auto-run: keep starting eligible work as slots free up. Off until the user turns it on. */
  autoDispatch: boolean
  /**
   * When Auto-run was last switched on (ISO time). Failed reviews before it no longer hold a task:
   * switching on is the person saying "go".
   */
  autoDispatchSince?: string
  theme: ThemeSettings
  shortcuts: ShortcutBindings
  updates: UpdateSettings
  /** Whether the terminal tabs of the last session are offered after a relaunch. */
  restoreTabs: RestoreTabsMode
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
  'restoreTabs',
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
  'worktreeLocation',
  'claudeCommand',
  'claudeApprovalMode',
  'codexCommand',
  'codexApprovalReviewer',
  'enabledProviders',
  'defaultProvider',
  'agentModels',
  'providerRouting',
  'defaultPromptTemplateId',
  'promptTemplates',
  'promptRouting',
  'orchestration',
  'autoDispatch',
  'autoDispatchSince',
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
  /** The Worklog view and its header tab. */
  worklog: boolean
  /**
   * Workspaces that live on another machine and are reached over `ssh` (`docs/architecture/
   * remote.md`). Off, remote workspaces stay listed but never connect.
   */
  remoteWorkspaces: boolean
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
