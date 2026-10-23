import { existsSync } from 'node:fs'
import type { ShellRunner } from '@core/agentCli.js'
import { checkMcpSetup, type McpSetupTarget } from '@core/mcpSetup.js'
import { resolveShell } from '@core/platformShell.js'
import { providerById } from '@core/providers/index.js'
import type { McpSetupReport, Settings } from '@core/types.js'

/**
 * Whether each agent CLI has the Styr MCP server registered at this install (`core/mcpSetup.ts`
 * decides), for Settings → Integrations and the quick-add and New task dialogs. Asked only on
 * demand, never from a write, a watcher, focus or a timer.
 */
export function createMcpSetupChecks(
  runShell: ShellRunner,
  mcpEntry: () => string,
  loadSettings: () => Settings,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync
) {
  /**
   * Registered answers, by platform, shell, command and expected entry. Only success is
   * remembered: a missing, stale or unknown answer is checked again, so registering the server
   * works without restarting Styr. A registration changed from outside after a success is seen on
   * Re-check (`fresh`) or the next restart.
   */
  const verified = new Map<string, McpSetupReport>()

  async function mcpSetupStatus(request: {
    provider: McpSetupReport['provider']
    /** Bypass the remembered answer and refresh it (Settings → Re-check). */
    fresh?: boolean
  }): Promise<McpSetupReport> {
    const settings = loadSettings()
    const expected = mcpEntry()
    const target: McpSetupTarget = {
      provider: request.provider,
      command: providerById(request.provider).command(settings),
      shell: resolveShell(settings.shell, platform),
      platform
    }
    const key = `${platform}\0${request.provider}\0${target.shell.path}\0${target.command}\0${expected}`
    const remembered = verified.get(key)
    if (remembered && !request.fresh) return remembered
    const report = await checkMcpSetup(target, expected, runShell, exists)
    if (report.state === 'registered') verified.set(key, report)
    else verified.delete(key)
    return report
  }

  return { mcpSetupStatus }
}
