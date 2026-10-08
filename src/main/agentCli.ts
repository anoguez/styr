import { execFile } from 'node:child_process'
import { checkAgentCli, type AgentCliTarget, type ShellRunner } from '@core/agentCli.js'
import { defaultShell, shellEnvironment } from '@core/platformShell.js'
import type { AgentCliReport, Settings } from '@core/types.js'

const CHECK_TIMEOUT_MS = 15_000

const runShell: ShellRunner = (shell, args) =>
  new Promise((resolve) => {
    execFile(
      shell,
      args,
      {
        env: { ...process.env, ...shellEnvironment(shell) },
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

function targetFor(provider: AgentCliReport['provider'], settings: Settings): AgentCliTarget {
  return {
    provider,
    command: provider === 'claude' ? settings.claudeCommand : settings.codexCommand,
    // Blank means the platform default, as it does for the terminal itself (ptyManager).
    shell: settings.shell || defaultShell(),
    platform: process.platform
  }
}

/** Runs the check now, for Settings: what the user sees should be current, not remembered. */
export async function agentCliStatus(
  target: Omit<AgentCliTarget, 'platform'>
): Promise<AgentCliReport> {
  const full = { ...target, shell: target.shell || defaultShell(), platform: process.platform }
  const report = await checkAgentCli(full, runShell)
  const key = `${full.platform}\0${full.shell}\0${full.command}`
  if (report.status.state === 'ready') verified.set(key, report)
  else verified.delete(key)
  return report
}

/** Refuses (throws) when the provider's CLI cannot start from the terminal's shell. */
export async function ensureAgentCli(
  provider: AgentCliReport['provider'],
  settings: Settings
): Promise<void> {
  const target = targetFor(provider, settings)
  const key = `${target.platform}\0${target.shell}\0${target.command}`
  if (verified.has(key)) return
  const report = await checkAgentCli(target, runShell)
  if (report.status.state !== 'ready') {
    throw new Error(
      report.installCommand ? `${report.problem}\n\n${report.installCommand}` : report.problem
    )
  }
  verified.set(key, report)
}
