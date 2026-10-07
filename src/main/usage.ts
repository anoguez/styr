import { delimiter, join } from 'node:path'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { app, BrowserWindow, ipcMain } from 'electron'
import chokidar from 'chokidar'
import { configDir } from '@core/config.js'
import { parseUsageFile, type ProviderUsage } from '@core/usage.js'

/** Account-wide, so it lives beside the global config, not in a workspace. */
const claudeUsageFile = (): string => join(configDir(), 'usage', 'claude.json')

/** Plain files beside the asar when packaged (`extraResources`): Claude Code cannot read an asar. */
function claudeModsRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'claude')
    : join(app.getAppPath(), 'resources', 'claude')
}

/**
 * Environment that makes a Claude Code started in a Styr terminal load the usage mod and say where
 * to write. Added to every terminal, not just agent sessions: a shell tab can run `claude` too.
 * Any plugin folders the user already exports are kept.
 */
export function usageEnv(existing: string | undefined): Record<string, string> {
  const mod = join(claudeModsRoot(), 'usage-mod')
  if (!existsSync(mod)) return {}
  return {
    CLAUDE_CODE_PLUGIN_DIRS: existing ? `${existing}${delimiter}${mod}` : mod,
    STYR_USAGE_FILE: claudeUsageFile()
  }
}

function readClaudeUsage(): ProviderUsage | null {
  try {
    return parseUsageFile(readFileSync(claudeUsageFile(), 'utf8'))
  } catch {
    return null
  }
}

/** Serves the last reading and pushes each new one. Read-only: the mod is the only writer. */
export function initUsage(): void {
  ipcMain.handle('usage:claude', () => readClaudeUsage())
  const file = claudeUsageFile()
  mkdirSync(join(configDir(), 'usage'), { recursive: true })
  chokidar
    .watch(file, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 60 } })
    .on('add', push)
    .on('change', push)

  function push(): void {
    const usage = readClaudeUsage()
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('usage:claude', usage)
  }
}
