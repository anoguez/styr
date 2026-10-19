import type { AgentStatus } from '@core/agentState.js'
import { remoteEditorFor, remoteEditorUri } from '@core/remote.js'
import type {
  BrokenSettingsFile,
  GlobalSettings,
  RemoteHostState,
  RemoteState,
  RemoteWorkspaceLink,
  RemoteWorkspaceState,
  Settings,
  Task,
  TerminalOutput,
  TerminalSessionInfo,
  WorkspaceBoardSummary,
  WorkspaceOverview,
  WorkspacesActivity
} from '@core/types.js'
import {
  ACTIVE_CHANNELS,
  BOARD_BROADCASTS,
  OFFLINE_DEFAULTS,
  SESSION_BROADCASTS,
  SESSION_CHANNELS,
  WRITE_CHANNELS
} from './channels.js'
import type { ConnectionEvents } from './connection.js'
import { Snapshots, createForwarder, disabledMessage } from './forwarding.js'
import {
  RemoteRegistry,
  createHostEntry,
  type Connection,
  type HostEntry,
  type RegistryPorts
} from './registry.js'
import { createRollup } from './rollup.js'
import { createRemoteSettings } from './settings.js'
import { createRemoteTerminals } from './terminals.js'
import { createRemoteWorkspaces } from './workspaces.js'

/**
 * The client side of remote workspaces (`docs/architecture/remote.md`): one router in the main
 * process decides, per IPC call, whether a local workspace's in-process host answers it or a
 * remote one's `RemoteConnection` does. Calls that carry no workspace go where the active one is;
 * terminal calls go where their session runs. Broadcasts from the local services and from every
 * connected server are merged here before they reach the renderer, so its API stays the same.
 *
 * This file composes the parts and owns the connections' lifecycle and events:
 * - `channels.ts`: which channel goes where;
 * - `registry.ts`: which workspaces are remote, each host's state, the id mapping;
 * - `forwarding.ts`: sending a board call, snapshots, refusing writes while not live;
 * - `terminals.ts`: remote sessions, attach and reattach, the engine's mirror;
 * - `workspaces.ts`: the servers' active workspace, switching it, the merged views;
 * - `settings.ts`: the server's workspace keys with this machine's app-level ones;
 * - `rollup.ts`: the merged tray and switcher rollup.
 *
 * Electron-free: everything Electron does is a port, and the connections come from `connect`, so
 * the tests use a fake transport.
 */

export interface RouterPorts extends RegistryPorts {
  /** Opens a host's connection; `link` names the server command. */
  connect(host: string, link: RemoteWorkspaceLink, events: ConnectionEvents): Connection
  /** To every window. */
  broadcast(channel: string, payload?: unknown): void
  notify(title: string, body: string): void
  /** The merged tray model (main's `updateTray`); `quiet` keys must not raise "needs you". */
  updateTray(statuses: AgentStatus[], titles: Map<string, string>, quiet: ReadonlySet<string>): void
  /** Opens a link outside Styr (a `vscode://` URI). */
  openExternal(url: string): void
  /** Whether a terminal session runs on this machine. */
  isLocalSession(id: string): boolean
  /** Saves the app-level settings only, as a Save from the dialog would, minus the workspace file. */
  saveGlobalSettings(global: GlobalSettings): void
}

export function createRemoteRouter(ports: RouterPorts) {
  const registry = new RemoteRegistry(ports)
  const snapshots = new Snapshots()
  const terminals = createRemoteTerminals(registry, ports)
  const forwarder = createForwarder(registry, snapshots, terminals.recordSessions)
  const rollup = createRollup(registry, ports)
  const workspaces = createRemoteWorkspaces(registry, {
    stateChanged: emitState,
    switched: (entry) => {
      if (registry.activeRemote()?.host === entry) refreshBoard(entry)
    }
  })
  /** Set by the caller (`bindSettings`), so the router reads settings the way main does. */
  let loadSettings: () => Settings = () => {
    throw new Error('Remote router: settings are not bound.')
  }
  const settings = createRemoteSettings(registry, snapshots, {
    load: () => loadSettings(),
    saveGlobalSettings: ports.saveGlobalSettings
  })

  // ── Connections ─────────────────────────────────────────────────────────────────────────

  /**
   * Re-reads the flag and the stubs, and opens or closes host connections to match. Called at
   * start and whenever the local workspaces or settings change; with the flag off nothing
   * connects and no `ssh` runs.
   */
  function refresh(): void {
    const hadRemote = registry.any
    registry.reload()
    const wanted = registry.wantedHosts()
    for (const [host, entry] of registry.hosts) {
      if (wanted.has(host)) continue
      registry.hosts.delete(host)
      entry.conn.stop()
      terminals.forgetHost(entry)
    }
    for (const [host, link] of wanted) {
      if (registry.hosts.has(host)) continue
      const entry = createHostEntry(host, undefined as unknown as Connection)
      entry.conn = ports.connect(host, link, connectionEvents(entry))
      registry.hosts.set(host, entry)
      const active = registry.links.get(registry.activeId())
      if (active?.remote.host === host) entry.wantSwitch = active.remote.workspaceId
      entry.conn.start()
    }
    snapshots.retain(registry.links)
    // With no remote workspace before or after, nothing is broadcast: the app is as it was.
    if (!hadRemote && registry.links.size === 0) return
    rollup.emitAll()
    emitState()
  }

  function connectionEvents(entry: HostEntry): ConnectionEvents {
    return {
      state: () => emitState(),
      connected: (_hello, reconnect) => void onConnected(entry, reconnect),
      disconnected: () => onDisconnected(entry),
      notification: (method, params) => onNotification(entry, method, params)
    }
  }

  /**
   * On every (re)connect: the server's list and active workspace, a switch if the user asked for
   * one, the terminals reattached with their backlog, the rollup and tray as a fresh baseline, and
   * the board refetched. A reconnect never switches the server on its own: if another client moved
   * it meanwhile, the badge says so and offers Switch back.
   */
  async function onConnected(entry: HostEntry, reconnect: boolean): Promise<void> {
    await workspaces.fetchOverview(entry)
    if (!reconnect && !entry.wantSwitch) {
      const active = registry.links.get(registry.activeId())
      if (active?.remote.host === entry.host) entry.wantSwitch = active.remote.workspaceId
    }
    const active = registry.activeRemote()
    if (
      entry.wantSwitch &&
      active?.host === entry &&
      active.link.workspaceId === entry.wantSwitch
    ) {
      workspaces.requestSwitch(active)
    }
    entry.wantSwitch = undefined
    entry.trayBaseline = true
    await Promise.all([
      terminals.reattach(entry),
      entry.conn.request('workspaces:activity').then(
        (activity) => rollup.setActivity(entry, activity as WorkspacesActivity),
        () => undefined
      ),
      entry.conn.request('server:tray').then(
        (tray) => rollup.setTray(entry, tray),
        () => undefined
      )
    ])
    emitState()
    if (registry.activeRemote()?.host === entry && !entry.switching) refreshBoard(entry)
    ports.broadcast('workspaces:changed')
  }

  function onDisconnected(entry: HostEntry): void {
    entry.attaching.clear()
    rollup.clearHost(entry)
    emitState()
  }

  /** Tells the renderer to fetch the board again, now that the server shows it. */
  function refreshBoard(entry: HostEntry): void {
    ports.broadcast('tasks:changed')
    emitSettings()
    const target = registry.activeRemote()
    if (!target || target.host !== entry || !registry.isLive(target)) {
      ports.broadcast('agents:changed', [])
      return
    }
    void forwarder.forward(target, 'agents:list', []).then(
      (agents) => ports.broadcast('agents:changed', agents),
      () => undefined
    )
    void forwarder.forward(target, 'orchestrate:autoState', []).then(
      (state) => ports.broadcast('orchestrate:autoState', state),
      () => undefined
    )
  }

  /** A broadcast or event from a server. */
  function onNotification(entry: HostEntry, method: string, params: unknown[]): void {
    const payload = params[0]
    switch (method) {
      case 'terminal:data':
        return terminals.onData(entry, payload as { id: string } & TerminalOutput)
      case 'terminal:exit':
        return terminals.onExit(entry, payload as { id: string; exitCode: number })
      case 'server:tray':
        return rollup.setTray(entry, payload)
      case 'workspaces:activity':
        return rollup.setActivity(entry, payload as WorkspacesActivity)
      case 'server:notify': {
        // Raised from the live stream only: nothing that happened while disconnected is backfilled.
        const { title, body } = (payload ?? {}) as { title?: unknown; body?: unknown }
        ports.notify(String(title ?? 'Styr'), `${entry.host} · ${String(body ?? '')}`)
        return
      }
      case 'workspaces:changed':
        // Not live until the server's list says which workspace it shows now.
        entry.overviewStale = true
        void workspaces.fetchOverview(entry).then(() => {
          emitState()
          ports.broadcast('workspaces:changed')
        })
        return
      case 'settings:changed': {
        // Carries the server's active workspace: a move by another client is noticed here,
        // before any refetch could read the other board.
        const serverActive = (payload as Settings | undefined)?.activeWorkspaceId
        if (serverActive) entry.serverActiveId = serverActive
        emitState()
        if (registry.activeOnLive(entry)) emitSettings()
        return
      }
    }
    if (SESSION_BROADCASTS.has(method)) {
      ports.broadcast(method, registry.mapIn(entry.host, payload))
      return
    }
    if (!BOARD_BROADCASTS.has(method) || !registry.activeOnLive(entry)) return
    const mapped = registry.mapIn(entry.host, payload)
    if (method === 'orchestrate:autoStarted' && mapped && typeof mapped === 'object') {
      terminals.tagSession(entry, mapped as TerminalSessionInfo)
    }
    if (params.length === 0) ports.broadcast(method)
    else ports.broadcast(method, mapped)
  }

  // ── Calls ───────────────────────────────────────────────────────────────────────────────

  /**
   * Answers one invoke call; `local` runs the in-process handler. With no remote workspace at
   * all, it is the handler itself, called synchronously as before.
   */
  function invoke(channel: string, args: unknown[], local: () => unknown): unknown {
    if (!registry.enabled && registry.links.size === 0) return local()
    return route(channel, args, local)
  }

  /** Async, but `local()` still runs before the first `await`, so calls keep their order. */
  async function route(channel: string, args: unknown[], local: () => unknown): Promise<unknown> {
    switch (channel) {
      case 'workspaces:list':
        return workspaces.mergeOverview((await local()) as WorkspaceOverview)
      case 'workspaces:activity':
        return rollup.mergedActivity()
      case 'workspaces:boardSummary':
        return workspaces.mergeSummaries((await local()) as Record<string, WorkspaceBoardSummary>)
      case 'workspaces:switch':
        return switchTo(String(args[0]), local)
      case 'workspaces:create':
      case 'workspaces:rename':
      case 'workspaces:delete': {
        const overview = (await local()) as WorkspaceOverview
        refresh()
        return workspaces.mergeOverview(overview)
      }
      case 'settings:get':
        return settings.get(typeof args[0] === 'string' ? args[0] : undefined, local)
      case 'settings:save':
        return settings.save(args[0], local)
      case 'settings:brokenFiles':
        return settings.brokenFiles((await local()) as BrokenSettingsFile[])
      case 'terminal:list':
        return terminals.list((await local()) as TerminalSessionInfo[])
      case 'diagnostics:snapshot':
        return diagnostics(args, local)
      case 'tasks:reveal':
        // A remote file has no place in this machine's file manager.
        return registry.target().kind === 'local' ? local() : undefined
      case 'tasks:openInEditor':
        return openInEditor(String(args[0]), local)
      case 'terminal:openInCode': {
        const target = registry.activeRemote()
        if (!target) return local()
        ports.openExternal(remoteEditorUri('vscode', target.link.host, String(args[0])))
        return 'code'
      }
      case 'terminal:revealDirectory': {
        const target = registry.activeRemote()
        return target ? `This folder is on ${target.link.host}.` : local()
      }
    }
    if (SESSION_CHANNELS.has(channel)) {
      const id = String(args[0])
      const entry = terminals.sessionHost(id)
      if (!entry) return local()
      if (channel === 'terminal:backlog') return terminals.attach(entry, id)
      return forwarder.forwardToHost(entry, channel, args)
    }
    if (!ACTIVE_CHANNELS.has(channel)) return local()
    const target = registry.target()
    if (target.kind === 'local') return local()
    if (target.kind === 'disabled') {
      if (WRITE_CHANNELS.has(channel)) throw new Error(disabledMessage(target.workspace))
      return OFFLINE_DEFAULTS[channel]?.() ?? local()
    }
    return forwarder.forward(target, channel, args)
  }

  async function switchTo(id: string, local: () => unknown): Promise<WorkspaceOverview> {
    const target = registry.target(id)
    if (target.kind === 'disabled') throw new Error(disabledMessage(target.workspace))
    const overview = (await local()) as WorkspaceOverview
    if (target.kind === 'remote') workspaces.requestSwitch(target)
    else emitState()
    return workspaces.mergeOverview(overview)
  }

  /** The server's diagnostics, with this machine's terminal engine (it draws here). */
  async function diagnostics(args: unknown[], local: () => unknown): Promise<unknown> {
    const target = registry.target()
    if (target.kind !== 'remote') return local()
    const [remote, mine] = await Promise.all([
      forwarder.forward(target, 'diagnostics:snapshot', args),
      local()
    ])
    return {
      ...(remote as object),
      terminalEngine: (mine as { terminalEngine?: unknown }).terminalEngine
    }
  }

  /**
   * A remote task file opens in VS Code or Cursor over ssh (`vscode://vscode-remote/…`); any other
   * editor cannot reach it, so nothing happens (the renderer disables the button and names the
   * remote path). The path is passed on as text, never resolved here.
   */
  async function openInEditor(id: string, local: () => unknown): Promise<void> {
    const target = registry.target()
    if (target.kind === 'local') {
      await local()
      return
    }
    if (target.kind !== 'remote') return
    const task = (await forwarder.forward(target, 'tasks:get', [id])) as Task | null
    const editor = remoteEditorFor((await settings.get(undefined)).openFilesWith)
    if (task && editor) {
      ports.openExternal(remoteEditorUri(editor, target.link.host, task.filePath))
    }
  }

  // ── Broadcasts from this machine's services ─────────────────────────────────────────────

  /**
   * Every broadcast the local services make passes through here. While a remote board is active
   * the local board's events are dropped (the server's take their place), the rollup is merged,
   * and a change to the workspaces or settings re-reads which workspaces are remote.
   */
  function fromLocal(channel: string, payload?: unknown): void {
    if (channel === 'workspaces:activity') {
      return rollup.localActivityChanged(payload as WorkspacesActivity)
    }
    if (channel === 'workspaces:changed' || channel === 'settings:changed') refresh()
    // A remote board's settings are the server's, with this machine's app-level keys laid over.
    if (channel === 'settings:changed' && registry.activeRemote()) return emitSettings()
    // Checked first: terminal data passes through here on every chunk.
    const target = BOARD_BROADCASTS.has(channel) ? registry.target() : undefined
    if (target?.kind === 'remote') {
      if (registry.isLive(target)) return
      // Offline, the board is the last snapshot: the local stub's empty agent list must not
      // replace it, but a request to refetch is harmless.
      if (channel === 'agents:changed') {
        return ports.broadcast(
          'agents:changed',
          snapshots.get(target.workspace.id, 'agents:list') ?? []
        )
      }
      if (channel !== 'tasks:changed') return
    }
    if (payload === undefined) ports.broadcast(channel)
    else ports.broadcast(channel, payload)
  }

  function emitSettings(): void {
    void settings.get(undefined).then(
      (merged) => ports.broadcast('settings:changed', merged),
      () => undefined
    )
  }

  // ── State for the renderer ──────────────────────────────────────────────────────────────

  function state(): RemoteState {
    const remoteWorkspaces: Record<string, RemoteWorkspaceState> = {}
    for (const stub of registry.links.values()) {
      const entry = registry.hosts.get(stub.remote.host)
      const target = registry.target(stub.id)
      const elsewhere = entry ? registry.elsewhereName(entry, stub.remote.workspaceId) : undefined
      const error = entry?.errors.get(stub.remote.workspaceId)
      remoteWorkspaces[stub.id] = {
        host: stub.remote.host,
        remoteWorkspaceId: stub.remote.workspaceId,
        live: target.kind === 'remote' && registry.isLive(target),
        ...(elsewhere && !entry?.switching ? { elsewhere } : {}),
        ...(error ? { error } : {})
      }
    }
    return {
      enabled: registry.enabled,
      hosts: [...registry.hosts.values()].map(hostState),
      workspaces: remoteWorkspaces
    }
  }

  function hostState(entry: HostEntry): RemoteHostState {
    const id = entry.serverActiveId
    if (!entry.conn.connected || !id) return entry.conn.state()
    const name = entry.overview?.workspaces.find((w) => w.id === id)?.name ?? id
    return { ...entry.conn.state(), serverWorkspace: { id, name } }
  }

  function emitState(): void {
    ports.broadcast('remote:state', state())
  }

  return {
    refresh,
    invoke,
    send: terminals.send,
    fromLocal,
    localTrayChanged: rollup.localTrayChanged,
    state,
    isRemoteSession: terminals.isRemoteSession,
    mirrorBacklog: terminals.mirrorBacklog,
    ensureAttached: terminals.ensureAttached,
    onTerminalData: terminals.onTerminalData,
    onTerminalExit: terminals.onTerminalExit,
    /** How the router loads this machine's settings for the active workspace. */
    bindSettings(load: () => Settings): void {
      loadSettings = load
    },
    /** "Retry now" for one host, or every host (the network came back). */
    retry(host?: string): void {
      for (const entry of registry.hosts.values()) {
        if (!host || entry.host === host) entry.conn.retryNow()
      }
    },
    /** "Switch back": the server shows this workspace again. */
    switchBack(stubId: string): void {
      const target = registry.target(stubId)
      if (target.kind === 'remote') workspaces.requestSwitch(target)
    },
    /** The machine woke: every link is replaced, since one that slept may be dead. */
    wake(): void {
      for (const entry of registry.hosts.values()) entry.conn.wake(true)
    },
    suspend(): void {
      for (const entry of registry.hosts.values()) {
        entry.conn.suspend('The computer went to sleep.')
      }
    },
    stopAll(): void {
      for (const entry of registry.hosts.values()) entry.conn.stop()
      registry.hosts.clear()
    }
  }
}

export type RemoteRouter = ReturnType<typeof createRemoteRouter>
