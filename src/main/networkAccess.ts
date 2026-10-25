import { app, ipcMain, powerSaveBlocker } from 'electron'
import { pinWorkspace, pinnedWorkspaceId } from '@core/config.js'
import { loadSettings } from '@core/settingsStore.js'
import { globalSettingsFor } from '@core/types.js'
import { listWorkspaces } from '@core/workspaces.js'
import type { AccessConfig } from '@core/types/access.js'
import { createHub, PROTOCOL_VERSION } from '../server/hub.js'
import { createNetworkAccess, forwardToHub } from '../server/networkAccess.js'
import { channelTable, onLocalTray } from './ipc.js'
import { electronHost, onBroadcast } from './electronHost.js'
import { listSessions, resizeSession, sessionBacklog } from './terminal/ptyManager.js'

/**
 * Remote access in the desktop app (`docs/architecture/remote-access.md`): the same hub `styr
 * serve` runs, answering the same channel table (`ipc.ts`), over a WebSocket that devices paired
 * with a QR can open. It lives in the main process, never the renderer, and listens only when
 * Settings → Remote access is on.
 */
const startedAt = new Date().toISOString()
let lastTray: unknown = { statuses: [], titles: {} }

const hub = createHub({
  invoke: channelTable.invoke,
  send: channelTable.send,
  info: () => ({
    protocol: PROTOCOL_VERSION,
    version: app.getVersion(),
    pid: process.pid,
    startedAt,
    storageDir: loadSettings().storageDir,
    platform: `${process.platform} ${process.arch}`
  }),
  tray: () => lastTray,
  // The experimental switches are the desktop's own; the policy refuses the call.
  experimental: () => undefined,
  terminals: { backlog: sessionBacklog, resize: resizeSession },
  pin: { current: pinnedWorkspaceId, clear: () => pinWorkspace(undefined) }
})

/** A workspace is shared when it is flagged and is a real folder, not an ssh remote's stub. */
function isOpen(workspaceId: string): boolean {
  const settings = loadSettings()
  const workspace = listWorkspaces(settings).find((entry) => entry.id === workspaceId)
  if (!workspace || workspace.remote) return false
  return loadSettings(workspaceId).remoteAccess === true
}

const access = createNetworkAccess({
  hub,
  gate: {
    isOpen,
    activeId: () => loadSettings().activeWorkspaceId,
    sessionWorkspace: (id) => {
      const session = listSessions().find((entry) => entry.id === id && !entry.host)
      return { exists: session !== undefined, workspaceId: session?.workspaceId }
    },
    currentGlobal: () => globalSettingsFor(loadSettings()),
    sourcesOf: (id) => loadSettings(id).sources
  },
  keepAwake: {
    hold: () => powerSaveBlocker.start('prevent-app-suspension'),
    release: (id) => powerSaveBlocker.stop(id)
  },
  broadcast: (state) => electronHost.broadcast('access:changed', state),
  log: (message) => console.warn(message)
})

const configSchemaKeys: (keyof AccessConfig)[] = ['enabled', 'bindAddress', 'port', 'keepAwake']

/** Called once the app is ready: feeds the hub what the windows are told, and listens if left on. */
export function startNetworkAccess(): void {
  onBroadcast((channel, payload) => forwardToHub(hub, channel, payload))
  onLocalTray((statuses, titles) => {
    lastTray = { statuses, titles: Object.fromEntries(titles) }
    forwardToHub(hub, 'server:tray', lastTray)
  })
  void access.service.start()
}

/** Quitting closes the listener and every device's connection. */
export function stopNetworkAccess(): void {
  void access.service.stop()
}

/** The Settings screen's channels. They are the desktop's alone: the gate refuses `access:*`. */
export function registerAccessHandlers(): void {
  ipcMain.handle('access:state', () => access.service.state())
  ipcMain.handle('access:configure', (_event, patch: unknown) =>
    access.service.configure(pickConfig(patch))
  )
  ipcMain.handle('access:pair', () => access.service.pair())
  ipcMain.handle('access:cancelPair', () => access.service.cancelPairing())
  ipcMain.handle('access:revoke', (_event, deviceId: unknown) =>
    access.service.revoke(String(deviceId))
  )
}

/** Only the config's own keys, each of the right type: the renderer is not trusted with more. */
function pickConfig(value: unknown): Partial<AccessConfig> {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const patch: Partial<AccessConfig> = {}
  for (const key of configSchemaKeys) {
    const entry = raw[key]
    if (key === 'enabled' || key === 'keepAwake') {
      if (typeof entry === 'boolean') patch[key] = entry
    } else if (key === 'port') {
      if (typeof entry === 'number') patch.port = entry
    } else if (typeof entry === 'string') {
      patch[key] = entry
    }
  }
  return patch
}
