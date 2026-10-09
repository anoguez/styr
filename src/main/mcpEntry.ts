import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { configDir } from '@core/config.js'

/** The built main-process output, which holds the MCP server and the chunks it imports. */
function bundledMain(): string {
  const root = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath()
  return join(root, 'out', 'main')
}

/**
 * Where the AppImage's MCP server is copied. An AppImage mounts itself under /tmp/.mount_* only
 * while it runs, so a `claude mcp add` pointing inside it breaks as soon as Styr quits. This folder
 * outlives the app and keeps its path across updates, so the registered command stays valid.
 */
function appImageCopy(): string {
  return join(configDir(), 'mcp-server')
}

/**
 * Refreshes the AppImage's copy of the MCP server when the version changed. A no-op for every
 * other build, whose files already sit at a stable path. Never fatal: Board access is optional.
 */
export function syncAppImageMcp(): void {
  if (!process.env.APPIMAGE) return
  const target = appImageCopy()
  const stamp = join(target, 'VERSION')
  try {
    if (existsSync(stamp) && readFileSync(stamp, 'utf8') === app.getVersion()) return
    rmSync(target, { recursive: true, force: true })
    cpSync(bundledMain(), target, { recursive: true })
    writeFileSync(stamp, app.getVersion())
  } catch (error) {
    console.error('Styr could not copy the MCP server out of the AppImage:', error)
  }
}

/** The MCP server's entry file, as the `mcp add` command should name it. */
export function mcpEntry(): string {
  const base = process.env.APPIMAGE ? appImageCopy() : bundledMain()
  return join(base, 'mcp', 'index.mjs')
}
