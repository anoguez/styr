import type { TaskStatus } from './task.js'

/** How the UI names each agent CLI. */
export const AGENT_PROVIDER_LABELS: Record<'claude' | 'codex', string> = {
  claude: 'Claude Code',
  codex: 'Codex'
}

/** The program name each agent CLI is started by, to recognise one typed into a shell. */
export const AGENT_PROVIDER_PROGRAMS: Record<'claude' | 'codex', string> = {
  claude: 'claude',
  codex: 'codex'
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
  blocked: number
  missingWorkingDir: number
  idleSessions: number
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

/**
 * Whether an agent CLI starts from the terminal's shell. `unsupported_shell` is a shell that cannot
 * carry a launch (Windows PowerShell 5.1, cmd); `TerminalShell.unsupported` says why.
 */
export type AgentCliStatus =
  | { state: 'ready'; version: string }
  | { state: 'missing' }
  | { state: 'failed'; detail: string }
  | { state: 'unsupported_shell' }

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
