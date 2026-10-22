import { cpSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { configDir } from '@core/config.js'
import { loadSettings } from '@core/settingsStore.js'
import { nodePtySpawn } from '@host/terminals/nodePty.js'
import type { AppPaths } from '@host/ports.js'
import { PROTOCOL_VERSION, createHub, type ServerInfo } from './hub.js'
import { createServerHost } from './serverHost.js'
import { listen } from './socket.js'

export interface ServeOptions {
  socketPath: string
  version: string
  /** The folder holding `out/server/` and `resources/`: the repo, or the server bundle. */
  root: string
}

/**
 * Runs `styr serve` until SIGTERM or SIGINT: the host services, the hub and the socket. Stopping
 * kills the terminals, as quitting the desktop app does.
 */
export async function serve(options: ServeOptions): Promise<void> {
  // An agent's `STYR_WORKSPACE_ID` must never pin the server, as it never pins the main process:
  // a server started from an agent terminal would inherit it.
  delete process.env.STYR_WORKSPACE_ID

  const startedAt = new Date().toISOString()
  const appPaths: AppPaths = {
    isPackaged: false,
    version: options.version,
    appPath: options.root,
    resourcesPath: join(options.root, 'resources')
  }
  const info = (): ServerInfo => ({
    protocol: PROTOCOL_VERSION,
    version: options.version,
    pid: process.pid,
    startedAt,
    storageDir: loadSettings().storageDir,
    platform: `${process.platform} ${process.arch}`
  })

  // The last tray model, so a client that (re)connects can ask for it (`server:tray`).
  let tray: unknown = { statuses: [], titles: {} }
  const host = createServerHost({
    broadcast: (channel, payload) => {
      if (channel === 'server:tray') tray = payload
      hub.broadcast(channel, payload)
    },
    // A headless server has no desktop: the clients raise the notification.
    notify: (title, body) => hub.broadcast('server:notify', { title, body }),
    trashItem: async (path) => moveToTrash(path),
    appPaths,
    terminalData: (id, output) => hub.terminalData(id, output),
    terminalExited: (id) => hub.terminalExited(id),
    spawn: nodePtySpawn,
    mcpEntry: () => join(options.root, 'out', 'server', 'mcp', 'index.mjs'),
    processMetrics: serverMetrics()
  })
  const hub = createHub({
    invoke: host.invoke,
    send: host.send,
    info,
    tray: () => tray,
    experimental: host.setExperimental,
    terminals: { backlog: host.terminals.sessionBacklog, resize: host.terminals.resizeSession },
    pin: host.pin
  })

  const listener = await listen(options.socketPath, hub)
  host.start()
  process.stdout.write(`styr server ${options.version} listening on ${options.socketPath}\n`)

  // A crash would kill every agent the server runs; log and carry on, as Electron's main does.
  process.on('uncaughtException', (error) => console.error('Styr server:', error))
  process.on('unhandledRejection', (error) => console.error('Styr server:', error))

  await new Promise<void>((resolve) => {
    let stopping = false
    const stop = (): void => {
      if (stopping) return
      stopping = true
      void listener
        .close()
        .then(() => host.stop())
        .finally(resolve)
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  })
}

/**
 * Headless Linux has no trash: a deleted workspace folder is moved under `~/.styr/trash/`, so it
 * can still be recovered by hand.
 */
function moveToTrash(path: string): void {
  const trash = join(configDir(), 'trash')
  mkdirSync(trash, { recursive: true })
  const target = join(trash, `${Date.now()}-${basename(path)}`)
  try {
    renameSync(path, target)
  } catch {
    // A different filesystem: copy, then remove.
    cpSync(path, target, { recursive: true })
    rmSync(path, { recursive: true, force: true })
  }
}

/** The server process's CPU since the previous snapshot, and its memory. */
function serverMetrics() {
  let last = { cpu: process.cpuUsage(), at: performance.now() }
  return () => {
    const now = performance.now()
    const used = process.cpuUsage(last.cpu)
    const elapsedMs = Math.max(now - last.at, 1)
    last = { cpu: process.cpuUsage(), at: now }
    return [
      {
        type: 'Server',
        cpuPercent: ((used.user + used.system) / 1000 / elapsedMs) * 100,
        memoryMb: process.memoryUsage().rss / (1024 * 1024)
      }
    ]
  }
}
