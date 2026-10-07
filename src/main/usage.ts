import { basename, delimiter, join } from 'node:path'
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { app, BrowserWindow, ipcMain } from 'electron'
import chokidar from 'chokidar'
import { configDir } from '@core/config.js'
import {
  parseContextFile,
  parseUsageFile,
  type ContextUsage,
  type ProviderUsage
} from '@core/usage.js'

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
export function usageEnv(existing: string | undefined, terminalId: string): Record<string, string> {
  const mod = join(claudeModsRoot(), 'usage-mod')
  if (!existsSync(mod)) return {}
  return {
    CLAUDE_CODE_PLUGIN_DIRS: existing ? `${existing}${delimiter}${mod}` : mod,
    STYR_USAGE_FILE: claudeUsageFile(),
    STYR_CONTEXT_FILE: contextFile(terminalId)
  }
}

/** One file per terminal: context fill belongs to a session, unlike the account's quota. */
const contextDir = (): string => join(configDir(), 'usage', 'context')
const contextFile = (terminalId: string): string => join(contextDir(), `${terminalId}.json`)

function readContext(terminalId: string): ContextUsage | null {
  try {
    return parseContextFile(readFileSync(contextFile(terminalId), 'utf8'))
  } catch {
    return null
  }
}

/** A terminal's file means nothing once it is gone, and its id is never reused. */
export function forgetContext(terminalId: string): void {
  rmSync(contextFile(terminalId), { force: true })
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
  ipcMain.handle('usage:context', (_event, terminalId: string) => readContext(terminalId))
  // Ids are not reused, so files from a previous run are only litter.
  rmSync(contextDir(), { recursive: true, force: true })
  mkdirSync(contextDir(), { recursive: true })
  const file = claudeUsageFile()
  mkdirSync(join(configDir(), 'usage'), { recursive: true })
  chokidar
    .watch(file, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 60 } })
    .on('add', push)
    .on('change', push)

  chokidar
    .watch(contextDir(), {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 60 }
    })
    .on('add', pushContext)
    .on('change', pushContext)

  function pushContext(path: string): void {
    const terminalId = basename(path, '.json')
    const context = readContext(terminalId)
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('usage:context', { terminalId, context })
  }

  function push(): void {
    const usage = readClaudeUsage()
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('usage:claude', usage)
  }
}
