import { ipcMain, powerMonitor, shell, type IpcMain } from 'electron'
import { loadSettings } from '@core/settingsStore.js'
import { createRemoteWorkspace, listWorkspaces } from '@core/workspaces.js'
import type { GlobalSettings, RemoteWorkspaceDraft } from '@core/types.js'
import { RemoteConnection } from '@host/remote/connection.js'
import { createRemoteRouter } from '@host/remote/router.js'
import { sshTransport } from '@host/remote/sshTransport.js'
import { electronHost } from './electronHost.js'
import { listSessions, terminalRuntimeState } from './terminal/ptyManager.js'
import { updateTray } from './tray.js'

/**
 * Remote workspaces in the desktop app (`docs/architecture/remote.md`): the router from
 * `src/host/remote/`, bound to Electron. Every IPC handler `ipc.ts` and `usage.ts` register goes
 * through `routedIpcMain`, so a remote workspace's calls reach its server and a local one's run
 * in-process exactly as before. With the flag off and no remote workspace the router is a pass-through.
 */

let saveGlobal: (global: GlobalSettings) => void = () => {
  throw new Error('Remote workspaces: the settings service is not bound yet.')
}

export const remoteRouter = createRemoteRouter({
  enabled: () => loadSettings().experimental.remoteWorkspaces,
  workspaces: () => listWorkspaces(loadSettings()),
  activeWorkspaceId: () => loadSettings().activeWorkspaceId,
  connect: (host, link, events) =>
    new RemoteConnection(
      host,
      {
        spawn: () => sshTransport(link),
        setTimer: (run, ms) => setTimeout(run, ms),
        clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
        now: () => Date.now()
      },
      events
    ),
  broadcast: electronHost.broadcast,
  notify: electronHost.notify,
  updateTray: (statuses, titles, quiet) => updateTray(statuses, titles, quiet),
  openExternal: (url) => void shell.openExternal(url),
  isLocalSession: (id) =>
    listSessions().some((session) => session.id === id) || terminalRuntimeState(id) !== undefined,
  saveGlobalSettings: (global) => saveGlobal(global)
})
remoteRouter.bindSettings(() => loadSettings())

/** How `ipc.ts` saves the app-level settings alone (a Save aimed at a remote workspace). */
export function bindGlobalSettingsSave(save: (global: GlobalSettings) => void): void {
  saveGlobal = save
}

type Handler = Parameters<IpcMain['handle']>[1]
type Listener = Parameters<IpcMain['on']>[1]

/**
 * `ipcMain`, with each handler routed: a handler is registered as before, under its literal
 * channel (so the IPC contract test still finds it), but the router decides whether the handler
 * or a server answers.
 */
export function routedIpcMain(target: IpcMain): Pick<IpcMain, 'handle' | 'on'> {
  return {
    handle: (channel: string, handler: Handler) =>
      target.handle(channel, (event, ...args: unknown[]) =>
        remoteRouter.invoke(channel, args, () => handler(event, ...args))
      ),
    on: (channel: string, listener: Listener) =>
      target.on(channel, (event, ...args: unknown[]) =>
        remoteRouter.send(channel, args, () => listener(event, ...args))
      )
  } as Pick<IpcMain, 'handle' | 'on'>
}

/**
 * Starts the router once the handlers are registered: reads which workspaces are remote and, with
 * the flag on, connects to their hosts. Sleep drops every link and waking replaces it, since a
 * link that slept may be dead without ssh knowing yet; the renderer reports the network coming
 * back (`remote:retry`). None of it polls.
 */
export function startRemote(switchWorkspace: (id: string) => unknown): void {
  ipcMain.handle('remote:state', () => remoteRouter.state())
  ipcMain.handle('remote:retry', (_event, host?: unknown) =>
    remoteRouter.retry(typeof host === 'string' ? host : undefined)
  )
  ipcMain.handle('remote:switchBack', (_event, id: unknown) => remoteRouter.switchBack(String(id)))
  ipcMain.handle('remote:addWorkspace', (_event, draft: RemoteWorkspaceDraft) => {
    const settings = loadSettings()
    if (!settings.experimental.remoteWorkspaces) {
      throw new Error('Turn on remote workspaces in Settings → Experimental first.')
    }
    const created = createRemoteWorkspace(settings, {
      name: String(draft?.name ?? ''),
      host: String(draft?.host ?? ''),
      workspaceId: String(draft?.workspaceId ?? ''),
      ...(typeof draft?.server === 'string' ? { server: draft.server } : {})
    })
    remoteRouter.refresh()
    return switchWorkspace(created.id)
  })
  powerMonitor.on('suspend', () => remoteRouter.suspend())
  powerMonitor.on('resume', () => remoteRouter.wake())
  remoteRouter.refresh()
}
