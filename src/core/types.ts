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
  'commandPalette',
  'focusSearch',
  'settings',
  'toggleTerminal',
  'toggleAgents',
  'orchestrate',
  'newShell',
  'closeShell'
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
  worktreePath?: string
  contextFiles: string[]
  promptTemplateId?: string
  provider?: 'claude' | 'codex'
  agentSession?: { provider: 'claude' | 'codex'; id: string }
  sessions: TaskSessionRef[]
  externalRef?: ExternalRef
  order: number
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
}

export interface ActivityEntry {
  at: string
  author: string
  message: string
}

export type TaskDraft = Partial<Omit<Task, 'filePath' | 'format' | 'activity'>> &
  Pick<Task, 'title'>

export type TaskPatch = Partial<Omit<Task, 'id' | 'filePath' | 'format' | 'activity' | 'createdAt'>>

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
  commandPalette: ['mod+p', 'mod+k'],
  focusSearch: ['mod+f'],
  settings: ['mod+,'],
  toggleTerminal: ['ctrl+`', 'mod+`'],
  toggleAgents: [],
  orchestrate: [],
  newShell: ['mod+t'],
  closeShell: ['mod+w']
}

export interface Settings {
  workspaceDir: string
  defaultRepoPath: string
  shell: string
  claudeCommand: string
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
  provider?: 'claude' | 'codex'
  /** A read-back of a past chat rather than the task's live session. */
  replay?: boolean
}
