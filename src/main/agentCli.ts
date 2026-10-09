import { execFile } from 'node:child_process'
import { checkAgentCli, type AgentCliTarget, type ShellRunner } from '@core/agentCli.js'
import { resolveShell } from '@core/platformShell.js'
import type { AgentCliReport, Settings } from '@core/types.js'

const CHECK_TIMEOUT_MS = 15_000

const runShell: ShellRunner = (path, args, environment) =>
  new Promise((resolve) => {
    execFile(
      path,
      args,
      {
        env: { ...process.env, ...environment },
        timeout: CHECK_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr })
        const failure = error as NodeJS.ErrnoException & { code?: string | number }
        // A string code (ENOENT, ETIMEDOUT…) means the shell itself did not run to completion.
        const code = typeof failure.code === 'number' ? failure.code : null
        resolve({ code, stdout, stderr: stderr || (code === null ? failure.message : '') })
      }
    )
  })

/**
 * Successful checks, by platform, shell and command. Only success is remembered: a failure is
 * checked again on the next launch, so installing the CLI works without restarting Styr. A changed
 * command or shell is a different key, so editing Settings never reuses a stale answer.
 */
const verified = new Map<string, AgentCliReport>()

function keyOf(target: AgentCliTarget): string {
  return `${target.platform}\0${target.shell.path}\0${target.command}`
}

/** Runs the check now, for Settings: what the user sees should be current, not remembered. */
export async function agentCliStatus(request: {
  provider: AgentCliReport['provider']
  command: string
  /** As typed in Settings; blank means the platform default, as for the terminal itself. */
  shell: string
}): Promise<AgentCliReport> {
  const target: AgentCliTarget = {
    provider: request.provider,
    command: request.command,
    shell: resolveShell(request.shell),
    platform: process.platform
  }
  const report = await checkAgentCli(target, runShell)
  if (report.status.state === 'ready') verified.set(keyOf(target), report)
  else verified.delete(keyOf(target))
  return report
}

/** Refuses (throws) when the provider's CLI cannot start from the terminal's shell. */
export async function ensureAgentCli(
  provider: AgentCliReport['provider'],
  settings: Settings
): Promise<void> {
  const target: AgentCliTarget = {
    provider,
    command: provider === 'claude' ? settings.claudeCommand : settings.codexCommand,
    shell: resolveShell(settings.shell),
    platform: process.platform
  }
  if (verified.has(keyOf(target))) return
  const report = await checkAgentCli(target, runShell)
  if (report.status.state !== 'ready') {
    throw new Error(
      report.installCommand ? `${report.problem}\n\n${report.installCommand}` : report.problem
    )
  }
  verified.set(keyOf(target), report)
}
