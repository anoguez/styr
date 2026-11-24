import { app, ipcMain, powerSaveBlocker, safeStorage } from 'electron'
import { pinWorkspace, pinnedWorkspaceId } from '@core/config.js'
import { loadSettings } from '@core/settingsStore.js'
import { globalSettingsFor, workspaceSettingsFor, type SettingsChange } from '@core/types.js'
import { listWorkspaces } from '@core/workspaces.js'
import type { AccessConfigPatch, AccessState, AccessWorkspace } from '@core/types/access.js'
import type { SecretBox } from '@host/remoteAccess/accessStore.js'
import { tailscaleShieldsUp } from '@host/remoteAccess/tailscale.js'
import { computerName, createHub, PROTOCOL_VERSION } from '../server/hub.js'
import { createNetworkAccess, forwardToHub } from '../server/networkAccess.js'
import { channelTable, onLocalTray } from './ipc.js'
import { electronHost, onBroadcast } from './electronHost.js'
import { listSessions, resizeSession, sessionBacklog } from './terminal/ptyManager.js'

/**
 * Remote access in the desktop app (`docs/architecture/remote-access.md`): the same hub `styr
 * serve` runs, answering the same channel table (`ipc.ts`), over a WebSocket that devices paired
 * with a QR can open, from this computer's networks only. It lives in the main process, never the
 * renderer, and listens only when Settings → Remote devices is on.
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
    platform: `${process.platform} ${process.arch}`,
    name: computerName()
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

/**
 * The host's private key is sealed with `safeStorage` (the macOS Keychain, DPAPI, libsecret) once
 * it is there. Linux without a keyring falls back to a fixed key, which is no better than the file,
 * so the key then stays as it was: plaintext, 0600.
 */
function keychain(): SecretBox | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return undefined
  }
  return {
    seal: (plain) => safeStorage.encryptString(plain).toString('base64'),
    open: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  }
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
  log: (message) => console.warn(message),
  secrets: keychain,
  takesRequests: true,
  shieldsUp: () => tailscaleShieldsUp(),
  workspaces: localWorkspaces
})

/** This computer's own workspaces, never an ssh remote's stub, and whether each is shared. */
function localWorkspaces(): AccessWorkspace[] {
  return listWorkspaces(loadSettings())
    .filter((entry) => !entry.remote)
    .map((entry) => ({ id: entry.id, name: entry.name, shared: isOpen(entry.id) }))
}

/**
 * A switch in Settings → Connections: turns `remoteAccess` on or off for one of this computer's
 * workspaces through the ordinary save, so the workspaces, the hub (which detaches what a device
 * held in a workspace no longer shared) and every window hear `settings:changed` as after Save.
 * Only a workspace that exists here, and is not an ssh remote's stub, can be named.
 */
export async function setWorkspaceShared(
  workspaceId: unknown,
  shared: unknown
): Promise<AccessState> {
  if (typeof workspaceId !== 'string' || typeof shared !== 'boolean') {
    throw new Error('Expected a workspace id and whether to share it.')
  }
  const global = loadSettings()
  const workspace = listWorkspaces(global).find((entry) => entry.id === workspaceId)
  if (!workspace) throw new Error('That workspace no longer exists.')
  if (workspace.remote) {
    throw new Error(
      `${workspace.name} lives on a remote host; share it in its own settings, on that host.`
    )
  }
  const own = loadSettings(workspaceId)
  if (own.remoteAccess !== shared) {
    const change: SettingsChange = {
      workspaceId,
      workspace: { ...workspaceSettingsFor(own), remoteAccess: shared },
      global: globalSettingsFor(global)
    }
    await channelTable.invoke['settings:save']!.run(change as never)
  }
  return access.service.refresh()
}

/** What the access state is derived from besides its own store: which workspaces are shared. */
const SHARING_CHANGES = new Set(['settings:changed', 'workspaces:changed'])

/** Called once the app is ready: feeds the hub what the windows are told, and listens if left on. */
export function startNetworkAccess(): void {
  onBroadcast((channel, payload) => {
    forwardToHub(hub, channel, payload)
    if (SHARING_CHANGES.has(channel)) access.service.refresh()
  })
  onLocalTray((statuses, titles) => {
    lastTray = { statuses, titles: Object.fromEntries(titles) }
    forwardToHub(hub, 'server:tray', lastTray)
  })
  access.store.sealHostKey()
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
  ipcMain.handle('access:answer', (_event, requestId: unknown, allow: unknown) => {
    if (typeof requestId !== 'string' || typeof allow !== 'boolean') {
      throw new Error('Expected a request id and an answer.')
    }
    return access.service.answer(requestId, allow)
  })
  ipcMain.handle('access:checkNetwork', () => access.service.checkNetwork())
  ipcMain.handle('access:setShared', (_event, workspaceId: unknown, shared: unknown) =>
    setWorkspaceShared(workspaceId, shared)
  )
  ipcMain.handle('access:revoke', (_event, deviceId: unknown) =>
    access.service.revoke(String(deviceId))
  )
}

const asRecord = (value: unknown): Record<string, unknown> =>
  (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>

/**
 * Only the switches, each of the right type: the renderer is not trusted with more. The port is
 * not the renderer's to set; it is `styr serve --port`'s, or found free by the service.
 */
export function pickConfig(value: unknown): AccessConfigPatch {
  const raw = asRecord(value)
  const patch: AccessConfigPatch = {}
  if (typeof raw.enabled === 'boolean') patch.enabled = raw.enabled
  if (typeof raw.keepAwake === 'boolean') patch.keepAwake = raw.keepAwake
  return patch
}
