import type { TaskStatus } from './task.js'

/** How the UI names each agent CLI. */
export const AGENT_PROVIDER_LABELS: Record<'claude' | 'codex', string> = {
  claude: 'Claude Code',
  codex: 'Codex'
}

/** The agent's name in running text ("what Claude receives"). */
export const AGENT_PROVIDER_SHORT_LABELS: Record<'claude' | 'codex', string> = {
  claude: 'Claude',
  codex: 'Codex'
}

/** The program name each agent CLI is started by, to recognise one typed into a shell. */
export const AGENT_PROVIDER_PROGRAMS: Record<'claude' | 'codex', string> = {
  claude: 'claude',
  codex: 'codex'
}

/** A model name each CLI accepts, shown as an example where models are registered. */
export const AGENT_MODEL_EXAMPLES: Record<'claude' | 'codex', string> = {
  claude: 'opus',
  codex: 'gpt-6.1-sol'
}

export const ORCHESTRATION_LANES = ['spec', 'implement', 'review'] as const
export type OrchestrationLane = (typeof ORCHESTRATION_LANES)[number]

export const ORCHESTRATION_LANE_LABELS: Record<OrchestrationLane, string> = {
  spec: 'Specifying',
  implement: 'Implementing',
  review: 'Reviewing'
}

export type OrchestrationCapacity = Record<OrchestrationLane, number>

/** Why Auto-run switched itself off; absent when the user turned it off. */
export type AutoDispatchPause = 'limit' | 'failures'

export interface AutoDispatchState {
  on: boolean
  paused?: AutoDispatchPause
}

/** Why Auto-run switched itself off, short enough for a menu row (the tray). */
export const AUTO_DISPATCH_PAUSE_LABELS: Record<AutoDispatchPause, string> = {
  limit: 'Stopped itself: too many starts in an hour',
  failures: 'Stopped itself: three launches in a row failed'
}

/** What Orchestrate would do, without the task objects the renderer does not need. */
/** Auto-run's safety limits, a workspace setting. */
export interface AutoDispatchLimits {
  /** Auto launches per rolling hour before Auto-run switches itself off. */
  launchesPerHour: number
  /** Consecutive failed launches before Auto-run switches itself off. */
  failures: number
  /** Failed reviews (review → Backlog) after which Auto-run stops starting a task: it needs a person. */
  reviews: number
}

/** What a workspace gets until it changes them. */
export const DEFAULT_AUTO_LIMITS: AutoDispatchLimits = {
  launchesPerHour: 20,
  failures: 3,
  reviews: 3
}

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
  blocked: number
  missingWorkingDir: number
  idleSessions: number
  /** Planned tasks Auto-run holds back after too many failed reviews; Dispatch now still starts them. */
  reworkHeld: string[]
}

export interface PromptTemplate {
  id: string
  name: string
  template: string
  /**
   * The model this template runs with. Names are per CLI, so it applies only when the launch uses
   * `provider`; unset leaves the CLI's default.
   */
  model?: { provider: 'claude' | 'codex'; name: string }
}

export interface PromptRouting {
  needsSpec: string
  byStatus: Record<TaskStatus, string>
}

/**
 * Whether an agent CLI starts from the terminal's shell. `unsupported_shell` is a shell that cannot
 * carry a launch (Windows PowerShell 5.1, cmd); `TerminalShell.unsupported` says why.
 */
export type AgentCliStatus =
  | { state: 'ready'; version: string }
  | { state: 'missing' }
  | { state: 'failed'; detail: string }
  | { state: 'unsupported_shell' }

/**
 * Whether the Styr MCP server is registered with an agent CLI and points at this install.
 * `unknown` is a probe that could not tell (CLI missing, unsupported shell, timeout, odd output);
 * it is never reported as `missing`.
 */
export type McpSetupState = 'registered' | 'stale' | 'missing' | 'unknown'

export interface McpSetupReport {
  provider: 'claude' | 'codex'
  state: McpSetupState
  /** The script path the provider has registered, when it has a `styr` server. */
  registeredEntry?: string
  /** This host's MCP entry: what a registration should point at. */
  expectedEntry: string
  /** The command that registers the server, for the fix-it text. */
  installCommand: string
  /** The command that removes a stale registration first, when there is one. */
  removeCommand?: string
  /** One sentence on what is wrong; empty when registered. */
  problem: string
}

/** One agent CLI check, with what it ran and, when it is not ready, what to do about it. */
export interface AgentCliReport {
  provider: 'claude' | 'codex'
  command: string
  /** The shell's path, as configured or found. */
  shell: string
  /** The shell's name as shown to the user: "Git Bash", "PowerShell 7", "zsh". */
  shellLabel: string
  /** `process.platform` of the main process: the OS the agents actually run on. */
  platform: string
  status: AgentCliStatus
  /** What is wrong and how to fix it, in words; empty when ready. */
  problem: string
  /** A command that installs the CLI on this OS, when it is missing. */
  installCommand?: string
}
