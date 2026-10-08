import { basename } from 'node:path'
import { commandShellArgs, isPosixShell } from './platformShell.js'
import type { AgentCliReport, AgentCliStatus } from './types.js'

type Provider = AgentCliReport['provider']

/** The outcome of running one command line; `code` is null when the shell itself did not start. */
export interface ShellRun {
  code: number | null
  stdout: string
  stderr: string
}

/** Runs `shell` with `args`. Injected so the check is testable without spawning anything. */
export type ShellRunner = (shell: string, args: string[]) => Promise<ShellRun>

export interface AgentCliTarget {
  provider: Provider
  /** As configured in Settings → Integrations; may carry flags (`claude --model …`). */
  command: string
  shell: string
  platform: NodeJS.Platform
}

const LABELS: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' }

/** Exit status POSIX shells use for "command not found". */
const NOT_FOUND = 127

/** The official install command for `provider` on `platform`, as the user would paste it. */
export function installCommandFor(provider: Provider, platform: string): string {
  if (provider === 'codex') return 'npm install -g @openai/codex'
  return platform === 'win32'
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash'
}

/** How the shell is named to the user: Git for Windows' bash is "Git Bash". */
export function shellName(shell: string, platform: string): string {
  const name = basename(shell.replace(/\\/g, '/'))
  if (platform === 'win32' && /^bash(\.exe)?$/i.test(name)) return 'Git Bash'
  return name.replace(/\.exe$/i, '')
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.trim() ?? ''
}

function problemFor(target: AgentCliTarget, status: AgentCliStatus): string {
  const label = LABELS[target.provider]
  const shell = shellName(target.shell, target.platform)
  switch (status.state) {
    case 'ready':
      return ''
    case 'unsupported_shell':
      return (
        `${label} is started with POSIX shell commands, which ${shell} cannot run. Install Git ` +
        'for Windows and set Settings → Preferences → Shell to its bash.exe ' +
        '(usually C:\\Program Files\\Git\\bin\\bash.exe).'
      )
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
 * same login shell the terminal uses, so the PATH is the one an agent launch will see.
 */
export async function checkAgentCli(
  target: AgentCliTarget,
  run: ShellRunner
): Promise<AgentCliReport> {
  const report = (status: AgentCliStatus): AgentCliReport => ({
    ...target,
    status,
    problem: problemFor(target, status),
    ...(status.state === 'missing'
      ? { installCommand: installCommandFor(target.provider, target.platform) }
      : {})
  })

  if (target.platform === 'win32' && !isPosixShell(target.shell)) {
    return report({ state: 'unsupported_shell' })
  }
  const line = `${target.command} --version`
  const result = await run(target.shell, commandShellArgs(target.shell, line, target.platform))
  if (result.code === 0) {
    const version = /\d+\.\d+\.\d+[\w.-]*/.exec(result.stdout)?.[0] ?? firstLine(result.stdout)
    return report({ state: 'ready', version: version || 'unknown version' })
  }
  if (result.code === NOT_FOUND) return report({ state: 'missing' })
  const detail =
    result.code === null
      ? firstLine(result.stderr) || `the shell ${target.shell} could not be started`
      : firstLine(result.stderr) || firstLine(result.stdout) || `exit code ${result.code}`
  return report({ state: 'failed', detail })
}
