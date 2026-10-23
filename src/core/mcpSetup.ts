import type { ShellRunner } from './agentCli.js'
import type { TerminalShell } from './platformShell.js'
import { providerById } from './providers/index.js'
import type { McpSetupReport } from './types.js'

export interface McpSetupTarget {
  provider: McpSetupReport['provider']
  /** As configured in Settings → Integrations; may carry flags (`claude --model …`). */
  command: string
  /** The shell launches are typed into, as `resolveShell` describes it. */
  shell: TerminalShell
  platform: NodeJS.Platform
}

function normalise(path: string, platform: string): string {
  const win = platform === 'win32'
  const forward = (win ? path.trim().replace(/\\/g, '/') : path.trim()).replace(/\/+/g, '/')
  const trimmed = forward.length > 1 ? forward.replace(/\/$/, '') : forward
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/**
 * Whether the registered arguments name `expected`: the whole string is the path, or the path is one
 * of its words (a runner flag before it). Paths compare after normalising; case-insensitively on
 * Windows.
 */
export function pointsAt(registered: string, expected: string, platform: string): boolean {
  const want = normalise(expected, platform)
  if (normalise(registered, platform) === want) return true
  return registered
    .split(/\s+/)
    .map((word) => word.replace(/^["']|["']$/g, ''))
    .some((word) => normalise(word, platform) === want)
}

/**
 * Asks the provider's CLI, through the terminal's shell (an interactive login shell, so the PATH is
 * the one an agent sees), whether it has a `styr` MCP server pointing at `expectedEntry`. Detection
 * only: it never registers or edits anything.
 */
export async function checkMcpSetup(
  target: McpSetupTarget,
  expectedEntry: string,
  run: ShellRunner,
  exists: (path: string) => boolean
): Promise<McpSetupReport> {
  const provider = providerById(target.provider)
  const { shell } = target
  const installCommand = provider.mcpInstallCommand(expectedEntry, shell.syntax)
  const report = (
    state: McpSetupReport['state'],
    problem: string,
    registeredEntry?: string
  ): McpSetupReport => ({
    provider: target.provider,
    state,
    ...(registeredEntry ? { registeredEntry } : {}),
    expectedEntry,
    installCommand,
    ...(state === 'stale' ? { removeCommand: provider.mcpRemoveCommand(shell.syntax) } : {}),
    problem
  })

  if (shell.unsupported) {
    return report('unknown', `${provider.label} cannot be checked from ${shell.label}.`)
  }
  const line = provider.mcpProbeCommand(target.command, shell.syntax)
  const result = await run(shell.path, shell.terminalCommandArgs(line), shell.environment)
  const found = provider.parseMcpRegistration(result)
  if (found.state === 'missing') {
    return report(
      'missing',
      `${provider.label} has no Styr MCP server, so its agents only edit files.`
    )
  }
  if (found.state === 'unknown') {
    return report('unknown', `Could not tell whether ${provider.label} has the Styr MCP server.`)
  }
  const current = pointsAt(found.entry, expectedEntry, target.platform) && exists(expectedEntry)
  return current
    ? report('registered', '', found.entry)
    : report(
        'stale',
        `${provider.label}'s Styr MCP server points at ${found.entry}, not ${expectedEntry}.`,
        found.entry
      )
}
