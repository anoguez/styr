import type { TerminalShell } from './platformShell.js'
import { providerById } from './providers/index.js'
import { COMMAND_NOT_FOUND } from './shell.js'
import type { AgentCliReport, AgentCliStatus } from './types.js'

type Provider = AgentCliReport['provider']

/** The outcome of running one command line; `code` is null when the shell itself did not start. */
export interface ShellRun {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Runs the shell at `path` with `args` and the shell's extra `environment`. Injected so the check is
 * testable without spawning anything.
 */
export type ShellRunner = (
  path: string,
  args: string[],
  environment: Record<string, string>
) => Promise<ShellRun>

export interface AgentCliTarget {
  provider: Provider
  /** As configured in Settings → Integrations; may carry flags (`claude --model …`). */
  command: string
  /** The shell launches are typed into, as `resolveShell` describes it. */
  shell: TerminalShell
  platform: NodeJS.Platform
}

/** The official install command for `provider` on `platform`, as the user would paste it. */
export function installCommandFor(provider: Provider, platform: string): string {
  return providerById(provider).installCommand(platform)
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.trim() ?? ''
}

function problemFor(target: AgentCliTarget, status: AgentCliStatus): string {
  const label = providerById(target.provider).label
  const shell = target.shell.label
  switch (status.state) {
    case 'ready':
      return ''
    case 'unsupported_shell':
      return `${label} cannot be launched from ${shell}. ${target.shell.unsupported ?? ''}`.trim()
    case 'missing': {
      const where =
        target.platform === 'win32'
          ? ' Run the install command in PowerShell.'
          : ' Run the install command in a terminal.'
      return (
        `${label} (\`${target.command}\`) was not found by ${shell}.${where} If it is installed ` +
        `already, put it on the PATH ${shell} sees, or set its full path in Settings → Integrations.`
      )
    }
    case 'failed':
      return `\`${target.command} --version\` failed in ${shell}: ${status.detail}`
  }
}

/**
 * Checks that `target.command` starts from `target.shell` by asking it for its version, through the
 * same shell, with the same profiles, that a launch is typed into — so the PATH is the one the agent
 * will see. The probe is written in the shell's own syntax and exits 127 when the command does not
 * exist, whatever the shell.
 */
export async function checkAgentCli(
  target: AgentCliTarget,
  run: ShellRunner
): Promise<AgentCliReport> {
  const { shell } = target
  const report = (status: AgentCliStatus): AgentCliReport => ({
    provider: target.provider,
    command: target.command,
    shell: shell.path,
    shellLabel: shell.label,
    platform: target.platform,
    status,
    problem: problemFor(target, status),
    ...(status.state === 'missing'
      ? { installCommand: installCommandFor(target.provider, target.platform) }
      : {})
  })

  if (shell.unsupported) return report({ state: 'unsupported_shell' })
  const line = shell.syntax.exitIfNotFound(`${shell.syntax.invoke(target.command)} --version`)
  const result = await run(shell.path, shell.terminalCommandArgs(line), shell.environment)
  if (result.code === 0) {
    const version = /\d+\.\d+\.\d+[\w.-]*/.exec(result.stdout)?.[0] ?? firstLine(result.stdout)
    return report({ state: 'ready', version: version || 'unknown version' })
  }
  if (result.code === COMMAND_NOT_FOUND) return report({ state: 'missing' })
  const detail =
    result.code === null
      ? firstLine(result.stderr) || `the shell ${shell.path} could not be started`
      : firstLine(result.stderr) || firstLine(result.stdout) || `exit code ${result.code}`
  return report({ state: 'failed', detail })
}

/**
 * Why a launch is refused, or undefined when it may go ahead. Only a CLI the shell does not find, or
 * a shell that cannot carry a launch, is refused. Any other failure of `--version` (a timeout, a
 * noisy profile, an error from the CLI) lets the launch through, so the terminal shows what really
 * happens instead of an uncertain check blocking every agent.
 */
export function launchRefusal(report: AgentCliReport): string | undefined {
  const { state } = report.status
  if (state === 'ready' || state === 'failed') return undefined
  return report.installCommand ? `${report.problem}\n\n${report.installCommand}` : report.problem
}
