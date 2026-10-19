import { join } from 'node:path'
import { app, ipcMain, powerMonitor, shell, type IpcMain } from 'electron'
import { configDir } from '@core/config.js'
import { unsupportedHost, type HostProbe } from '@core/remoteSetup.js'
import { loadSettings } from '@core/settingsStore.js'
import { createRemoteWorkspace, listWorkspaces, validateWorkspaceName } from '@core/workspaces.js'
import type {
  GlobalSettings,
  RemoteHostInspection,
  RemoteSetupDraft,
  RemoteWorkspaceDraft,
  WorkspaceOverview
} from '@core/types.js'
import { RemoteConnection } from '@host/remote/connection.js'
import {
  createHostSetup,
  inspectRemoteHost,
  runRemoteSetup,
  type HostSetup
} from '@host/remote/hostSetup.js'
import { createRemoteRouter } from '@host/remote/router.js'
import { openServerSession } from '@host/remote/session.js'
import { createHostSetupPorts } from '@host/remote/sshRunner.js'
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
  saveGlobalSettings: (global) => saveGlobal(global),
  get clientVersion() {
    return app.getVersion()
  }
})
remoteRouter.bindSettings(() => loadSettings())

/**
 * The host steps (`src/host/remote/hostSetup.ts`) over the real ssh, scp and download. The
 * install script and the bundles' hashes ship inside the app: `install.sh` beside the asar,
 * `serverBundles.json` in `out/main/`, written by the release workflow before packaging.
 */
let setupInstance: HostSetup | undefined
function hostSetup(): HostSetup {
  setupInstance ??= createHostSetup(
    createHostSetupPorts({
      version: app.getVersion(),
      cacheDir: join(configDir(), 'server-bundles'),
      installScriptPath: app.isPackaged
        ? join(process.resourcesPath, 'server', 'install.sh')
        : join(app.getAppPath(), 'resources', 'server', 'install.sh'),
      hashesPath: join(app.getAppPath(), 'out', 'main', 'serverBundles.json')
    })
  )
  return setupInstance
}

/**
 * Asks a host's server for its workspaces: over the shared connection, or a one-off session. The
 * answer is parsed like any server answer (`validation.ts`).
 */
async function requestServerWorkspaces(
  host: string,
  method: 'workspaces:list' | 'workspaces:create',
  params: unknown[]
): Promise<WorkspaceOverview> {
  const shared = remoteRouter.requestOnHost(host, method, params)
  if (shared) return (await shared) as WorkspaceOverview
  const session = await openServerSession(host, {
    spawn: () => sshTransport({ host, workspaceId: 'default' }),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout)
  })
  try {
    return (await session.request(method, params)) as WorkspaceOverview
  } finally {
    session.close()
  }
}

/** Creates a workspace on a host's server and returns its id there. */
async function createServerWorkspace(host: string, name: string): Promise<string> {
  return (await requestServerWorkspaces(host, 'workspaces:create', [name])).activeId
}

/**
 * New workspace → Remote host's first step: ssh, the system, and, when a server already answers,
 * its boards by name, each marked when this computer already links to it. The probe is kept for
 * the setup that follows, so it does not run twice.
 */
const inspected = new Map<string, HostProbe>()
async function inspectHost(host: string): Promise<RemoteHostInspection> {
  inspected.delete(host)
  const probe = await inspectRemoteHost(
    {
      setup: hostSetup(),
      progress: (update) => electronHost.broadcast('remote:setupProgress', update)
    },
    host
  )
  inspected.set(host, probe)
  if (!probe.running) return { boards: [] }
  // A server that cannot list (another protocol, say) offers nothing to open; setup still runs.
  const overview = await requestServerWorkspaces(host, 'workspaces:list', []).catch(() => undefined)
  const links = listWorkspaces(loadSettings()).flatMap((workspace) =>
    workspace.remote?.host === host ? [workspace.remote.workspaceId] : []
  )
  return {
    running: probe.running,
    boards: (overview?.workspaces ?? []).map((board) => ({
      id: board.id,
      name: board.name,
      linked: links.includes(board.id)
    }))
  }
}

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
  const requireFlag = (): void => {
    if (!loadSettings().experimental.remoteWorkspaces) {
      throw new Error('Turn on remote workspaces in Settings → Experimental first.')
    }
  }
  /** Writes a local stub; the caller switches to it. */
  const addStub = (draft: RemoteWorkspaceDraft): string => {
    const created = createRemoteWorkspace(loadSettings(), draft)
    remoteRouter.refresh()
    return created.id
  }
  ipcMain.handle('remote:inspect', (_event, host: unknown) => {
    requireFlag()
    return inspectHost(String(host ?? '').trim())
  })
  // Open an existing workspace: a board the host's server already has gets a local stub only.
  ipcMain.handle('remote:addWorkspace', (_event, draft: RemoteWorkspaceDraft) => {
    requireFlag()
    const id = addStub({
      name: String(draft?.name ?? ''),
      host: String(draft?.host ?? '').trim(),
      workspaceId: String(draft?.workspaceId ?? '')
    })
    return switchWorkspace(id)
  })
  ipcMain.handle('remote:setup', async (_event, draft: RemoteSetupDraft) => {
    requireFlag()
    const name = String(draft?.name ?? '')
    const host = String(draft?.host ?? '').trim()
    // Checked before anything runs on the host, so a clash never leaves a workspace there.
    validateWorkspaceName(loadSettings(), name)
    const probe = inspected.get(host)
    inspected.delete(host)
    return runRemoteSetup(
      {
        setup: hostSetup(),
        version: app.getVersion(),
        createServerWorkspace,
        addStub: async (stub) => {
          const id = addStub(stub)
          await switchWorkspace(id)
          return id
        },
        progress: (update) => electronHost.broadcast('remote:setupProgress', update)
      },
      { name, host },
      probe
    )
  })
  ipcMain.handle('remote:runningAgents', (_event, host: unknown) =>
    remoteRouter.runningAgents(String(host))
  )
  // Upgrade server: the renderer has asked first, listing the agents a restart ends. The matching
  // version is installed beside the running one, then the restart makes it take over.
  ipcMain.handle('remote:upgrade', async (_event, value: unknown) => {
    requireFlag()
    const host = String(value)
    const probe = await hostSetup().probe(host)
    const refused = unsupportedHost(host, probe)
    if (refused) throw new Error(refused)
    await hostSetup().install(host, probe.arch!)
    await hostSetup().restart(host, remoteRouter.serverPid(host))
    remoteRouter.connect(host)
  })
  // Stop server: asked first in the renderer, with the running agents listed.
  ipcMain.handle('remote:stopServer', async (_event, value: unknown) => {
    const host = String(value)
    await hostSetup().stop(host, remoteRouter.serverPid(host))
    remoteRouter.disconnect(host)
  })
  ipcMain.handle('remote:disconnect', (_event, host: unknown) =>
    remoteRouter.disconnect(String(host))
  )
  // Connect: starts the installed server if it is not running (after Stop, or a reboot without
  // lingering), then connects. A host set up by hand may have no installed server to start; the
  // connection then says what went wrong.
  ipcMain.handle('remote:connect', async (_event, value: unknown) => {
    requireFlag()
    const host = String(value)
    await hostSetup()
      .start(host)
      .catch(() => undefined)
    remoteRouter.connect(host)
  })
  powerMonitor.on('suspend', () => remoteRouter.suspend())
  powerMonitor.on('resume', () => remoteRouter.wake())
  remoteRouter.refresh()
}
