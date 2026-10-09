import type { ShellSyntax } from '../shell.js'
import type { Settings } from '../types.js'

export const AGENT_PROVIDER_IDS = ['claude', 'codex'] as const
export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number]

export interface ProviderCommandInput {
  settings: Settings
  taskId: string
  sessionId: string
  /** Continue `sessionId` rather than start it. Only set once `sessionExists` has confirmed it. */
  resume: boolean
  /** Where the agent will run. Providers whose CLI cannot infer it from the shell need it. */
  cwd: string
  /** Start `sessionId` as a copy of this conversation instead of a blank one (an Ask fork). */
  forkFrom?: string
  /** A shell expression that expands to the prompt, or undefined to submit nothing. */
  prompt?: string
  /** The syntax of the shell the command is typed into; build every quoted part with it. */
  syntax: ShellSyntax
}

/**
 * Everything that differs between agent CLIs. `launch.ts` owns the shared flow — worktree, prompt
 * file, the resume-or-start decision — and asks the provider only for the parts it cannot know.
 */
export interface AgentProvider {
  id: AgentProviderId
  label: string
  /**
   * The command a terminal runs. May write support files the CLI reads at startup (Claude's hook
   * settings), so call it once per launch.
   */
  buildCommand(input: ProviderCommandInput): string
  newSessionId(): string
  /** Whether the CLI still has this conversation on disk. Never trust a stored id alone. */
  sessionExists(sessionId: string, homeRoot?: string): boolean
  /** When a past conversation was last written, for dating a chat we only learned about later. */
  sessionTime(sessionId: string, homeRoot?: string): string | undefined
  /** The command line that starts this CLI, as configured in Settings → Integrations. */
  command(settings: Settings): string
  /** The official command that installs this CLI on `platform`, as the user would paste it. */
  installCommand(platform: string): string
  /** The command a user runs once to give this CLI the board's MCP server. */
  mcpInstallCommand(serverEntry: string, syntax: ShellSyntax): string
  /**
   * Environment variables the CLI sets on its own processes to mark a running session. Styr strips
   * them from every terminal it opens, so an app started from inside such a session (`yarn dev` in
   * a Claude Code terminal) does not make its agents believe they are nested in it. Only session
   * markers belong here, never settings a user exports on purpose.
   */
  sessionEnvKeys: readonly string[]
}
