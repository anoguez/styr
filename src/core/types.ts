export const TASK_STATUSES = ['backlog', 'in_progress', 'in_review', 'done'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done'
}

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent'
}

export const ORCHESTRATION_LANES = ['spec', 'implement', 'review'] as const
export type OrchestrationLane = (typeof ORCHESTRATION_LANES)[number]

export const ORCHESTRATION_LANE_LABELS: Record<OrchestrationLane, string> = {
  spec: 'Specifying',
  implement: 'Implementing',
  review: 'Reviewing'
}

export type OrchestrationCapacity = Record<OrchestrationLane, number>

export const ANSI_COLOURS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const

export type AnsiColour = (typeof ANSI_COLOURS)[number]

/**
 * The 16 colours a program picks from when it emits colour. Unlike the interface, these cannot be
 * derived from the base — red has to stay red — so they are stored outright.
 */
export type TerminalPalette = Record<AnsiColour, string>

export interface ThemeSettings {
  base: string
  gradient: boolean
  gradientStrength: number
  gradientAngle: number
  accent: string
  columns: Record<TaskStatus, string>
  uiFont: string
  terminalFont: string
  terminalFontSize: number
  terminalPalette: TerminalPalette
}

export const SHORTCUT_COMMANDS = [
  'newTask',
  'quickTask',
  'commandPalette',
  'focusSearch',
  'viewBoard',
  'viewInbox',
  'settings',
  'toggleTerminal',
  'toggleAgents',
  'orchestrate',
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
  'terminalCreatePr'
] as const

export type ShortcutCommand = (typeof SHORTCUT_COMMANDS)[number]

/**
 * Accelerators per command. A list rather than one string so a command can keep an alternate —
 * the terminal panel answers to both Ctrl+` and Cmd+` — and so unbinding is an empty list rather
 * than a sentinel string.
 */
export type ShortcutBindings = Record<ShortcutCommand, string[]>

/** What Orchestrate would do, without the task objects the renderer does not need. */
export interface OrchestrationSummary {
  dispatch: {
    taskId: string
    title: string
    lane: OrchestrationLane
    provider: 'claude' | 'codex'
  }[]
  occupied: OrchestrationCapacity
  capacity: OrchestrationCapacity
  eligible: OrchestrationCapacity
  optedOut: number
  missingWorkingDir: number
  idleSessions: number
}

export const WORKTREE_BRANCH_PREFIX = 'styr/'

/** The workspace every install has. Its folder is the storage root itself, as before workspaces. */
export const DEFAULT_WORKSPACE_ID = 'default'
export const DEFAULT_WORKSPACE_NAME = 'Default'

/** An isolated board: its own tasks, agents and ids. Not to be confused with `storageDir`. */
export interface WorkspaceInfo {
  id: string
  name: string
}

/** The workspaces as the UI lists them, with what it needs to warn before a delete. */
export interface WorkspaceOverview {
  activeId: string
  workspaces: (WorkspaceInfo & { taskCount: number; liveSessions: number })[]
}

/**
 * What names a task's worktree and branch. Task ids are per workspace, so two workspaces can both
 * hold TASK-0001 on one repo; every non-default workspace therefore prefixes its id. Default keeps
 * the bare id so worktrees made before workspaces existed still resolve. Pure, because the prompt
 * (shared with the renderer) needs the branch name too.
 */
export function worktreeKey(workspaceId: string | undefined, taskId: string): string {
  return !workspaceId || workspaceId === DEFAULT_WORKSPACE_ID ? taskId : `${workspaceId}-${taskId}`
}

export const TASK_READINESS = ['ready', 'needs_spec'] as const
export type TaskReadiness = (typeof TASK_READINESS)[number]

export const TASK_READINESS_LABELS: Record<TaskReadiness, string> = {
  ready: 'Ready to work',
  needs_spec: 'Needs spec'
}

export type TaskSource = 'markdown' | 'json'

export interface Task {
  id: string
  title: string
  status: TaskStatus
  priority: TaskPriority
  readiness: TaskReadiness
  description: string
  activity: ActivityEntry[]
  project?: string
  tags: string[]
  repoPath?: string
  orchestrate: boolean
  useWorktree: boolean
  /** Branch the worktree starts from; unset means the main checkout's current branch. */
  baseBranch?: string
  worktreePath?: string
  contextFiles: string[]
  promptTemplateId?: string
  provider?: 'claude' | 'codex'
  agentSession?: { provider: 'claude' | 'codex'; id: string }
  sessions: TaskSessionRef[]
  externalRef?: ExternalRef
  prUrl?: string
  order: number
  /** When the task last entered Done. Falls back to `updatedAt` for files edited by hand. */
  doneAt?: string
  /** Set while the task is archived: off the board, still on disk. Independent of status. */
  archivedAt?: string
  createdAt: string
  updatedAt: string
  filePath: string
  format: TaskSource
}

/** One Claude conversation started for a task, kept so past runs stay reachable. */
export interface TaskSessionRef {
  id: string
  provider: 'claude' | 'codex'
  startedAt: string
  label: string
}

export interface ExternalRef {
  provider: string
  id: string
  url?: string
  /** Which source (`SourceConfig.id`) the item came from. */
  sourceId?: string
  /** Which repository of that source, e.g. `owner/name`; item ids repeat across repositories. */
  target?: string
  /** The remote item's last-update stamp at the last sync, for change detection. */
  remoteUpdatedAt?: string
  /** Hash of the title and body as last imported, to tell a local edit from the remote one. */
  syncedHash?: string
  /** Per-field hashes of the last import, so editing the title does not freeze the body. */
  syncedTitleHash?: string
  syncedBodyHash?: string
}

/** READ never changes anything in the source; READ/WRITE lets Styr push updates back. */
export type SourceAccess = 'read' | 'read_write'

/**
 * One integration, switched on and configured for the workspace. There is one per provider and no
 * repository in it: the repositories come from the tasks' own `repoPath`s.
 */
export interface SourceConfig {
  /** The provider's name; there is one source per provider. */
  id: string
  provider: string
  access: SourceAccess
  enabled: boolean
  /** Minutes between automatic syncs; 0 turns polling off. */
  pollMinutes: number
  /** Only items carrying all of these labels; empty means all. */
  labels: string[]
  includeClosed: boolean
  /** Write-side options; ignored unless `access` is `read_write`. */
  mirrorStatus: boolean
  commentOnReview: boolean
}

/** A repository found in a task's checkout, and the folder it was found in. */
export interface SourceTarget {
  /** GitHub: `owner/name`. */
  target: string
  repoPath: string
}

export interface RemoteItem {
  id: string
  url: string
  title: string
  body: string
  state: 'open' | 'closed'
  labels: string[]
  updatedAt: string
}

export interface ActivityEntry {
  at: string
  author: string
  message: string
}

export type TaskDraft = Partial<Omit<Task, 'filePath' | 'format' | 'activity'>> &
  Pick<Task, 'title'>

export type TaskPatch = Partial<
  Omit<Task, 'id' | 'filePath' | 'format' | 'activity' | 'createdAt' | 'archivedAt'>
>

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[]
  readiness?: TaskReadiness
  project?: string
  tag?: string
  query?: string
}

export interface PromptTemplate {
  id: string
  name: string
  template: string
}

export interface PromptRouting {
  needsSpec: string
  byStatus: Record<TaskStatus, string>
}

export const DEFAULT_TERMINAL_PALETTE: TerminalPalette = {
  black: '#1b2b38',
  red: '#e06c75',
  green: '#8cc98f',
  yellow: '#e5c07b',
  blue: '#6ea8fe',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#c8d1dc',
  brightBlack: '#4a5b6a',
  brightRed: '#f08b93',
  brightGreen: '#a7dba9',
  brightYellow: '#f2d49b',
  brightBlue: '#8fbdff',
  brightMagenta: '#d99af0',
  brightCyan: '#79cfd9',
  brightWhite: '#eef2f7'
}

export const DEFAULT_THEME: ThemeSettings = {
  base: '#0d2233',
  gradient: true,
  gradientStrength: 1,
  gradientAngle: 216,
  accent: '#6c3f75',
  columns: {
    backlog: '#f1f1e6',
    in_progress: '#5f8df7',
    in_review: '#f9f871',
    done: '#00c6c0'
  },
  uiFont: 'system',
  terminalFont: "'JetBrains Mono', ui-monospace, Menlo, monospace",
  terminalFontSize: 12,
  terminalPalette: DEFAULT_TERMINAL_PALETTE
}

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  newTask: ['mod+n'],
  quickTask: ['mod+shift+n'],
  commandPalette: ['mod+p', 'mod+k'],
  focusSearch: ['mod+f'],
  viewBoard: ['mod+1'],
  viewInbox: ['mod+2'],
  settings: ['mod+,'],
  toggleTerminal: ['ctrl+`', 'mod+`'],
  toggleAgents: [],
  orchestrate: [],
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
  terminalCreatePr: []
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
  theme: ThemeSettings
  shortcuts: ShortcutBindings
  updates: UpdateSettings
  experimental: ExperimentalSettings
  taskDefaults: TaskDefaults
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
  'theme',
  'taskDefaults',
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

/**
 * How much of the Done column stays on the board. Tasks over either limit are hidden, not
 * archived: they stay one click away ("Show all") and nothing is written to their files.
 * 0 disables a limit.
 */
export interface DoneCap {
  /** Show at most this many of the most recently finished tasks. */
  maxCount: number
  /** Hide tasks that finished more than this many days ago. */
  maxAgeDays: number
}

export const DEFAULT_DONE_CAP: DoneCap = { maxCount: 20, maxAgeDays: 14 }

/** Starting values for the new-task form. Existing tasks keep whatever they saved. */
export interface TaskDefaults {
  /** New tasks start with "Let Orchestrate start this task" checked. */
  orchestrate: boolean
  /** New tasks start with "Run in its own git worktree" checked. */
  useWorktree: boolean
}

/** Features still being tried out. Each is off until switched on in Settings → Experimental. */
export interface ExperimentalSettings {
  /** External sources (GitHub issues) under Settings → Integrations. */
  externalSources: boolean
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

export interface TerminalSessionInfo {
  id: string
  /** The task's title when the session was started, or a plain label for a shell. */
  title: string
  cwd: string
  taskId?: string
  /** The workspace the task belongs to; task ids are only unique within one. */
  workspaceId?: string
  provider?: 'claude' | 'codex'
  /** A read-back of a past chat rather than the task's live session. */
  replay?: boolean
}

/**
 * Where a command began or ended in a terminal's output stream. `offset` counts characters into the
 * `data` it travels with, so the renderer can pause between writes and anchor a marker exactly
 * there; nothing about it reaches xterm itself.
 */
export interface TerminalMark {
  offset: number
  kind: 'start' | 'end'
  /** The runtime's id for the command, shared by its start and end marks. */
  id: string
  command?: string
  exitCode?: number
  /** Epoch milliseconds. */
  at: number
}

/** One piece of a terminal's output, with the command boundaries inside it. */
export interface TerminalOutput {
  data: string
  sequence: number
  marks: TerminalMark[]
}

/** A completed shell command. Additional terminal and agent metadata can be added over time. */
export interface TerminalCommand {
  id: string
  command: string
  cwd: string
  startedAt: number
  endedAt?: number
  exitCode?: number
  /** Output is capped by the main-process terminal runtime. */
  output?: string
}

/**
 * Main-process owned semantic state for a terminal session. Unlike `TerminalSessionInfo.cwd`,
 * `cwd` follows the shell as it changes directories.
 */
export interface TerminalRuntimeState {
  sessionId: string
  cwd: string
  promptReady: boolean
  runningCommand?: Pick<TerminalCommand, 'id' | 'command' | 'cwd' | 'startedAt'>
  lastCommand?: TerminalCommand
  lastExitCode?: number
  terminated?: boolean
}

/** What the last sync of a source did, shown in the Integrations pane. */
export interface SourceSyncState {
  syncing: boolean
  lastAt?: string
  error?: string
  created: number
  updated: number
}

/** Whether an adapter's command-line tool is usable. */
export type CliStatus =
  | { state: 'missing' }
  | { state: 'outdated'; version: string; minimum: string }
  | { state: 'unauthenticated'; version: string }
  | { state: 'ready'; version: string; account?: string }
