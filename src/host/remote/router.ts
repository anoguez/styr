import { agentKey, type AgentStatus } from '@core/agentState.js'
import { remoteEditorFor, remoteEditorUri } from '@core/remote.js'
import { z } from 'zod'
import {
  globalSettingsFor,
  type BrokenSettingsFile,
  type GlobalSettings,
  type RemoteHostState,
  type RemoteState,
  type RemoteWorkspaceLink,
  type RemoteWorkspaceState,
  type Settings,
  type Task,
  type TerminalOutput,
  type TerminalSessionInfo,
  type WorkspaceBoardSummary,
  type WorkspaceInfo,
  type WorkspaceOverview,
  type WorkspacesActivity
} from '@core/types.js'
import type { ConnectionEvents, RemoteConnection, ServerHello } from './connection.js'
import { TerminalMirror } from './terminalMirror.js'

/**
 * The client side of remote workspaces (`docs/architecture/remote.md`): one router in the main
 * process decides, per IPC call, whether a local workspace's in-process host answers it or a
 * remote one's `RemoteConnection` does. Calls that carry no workspace go where the active one is;
 * terminal calls go where their session runs. Broadcasts from the local services and from every
 * connected server are merged here before they reach the renderer, so its API stays the same.
 *
 * Electron-free: everything Electron does (broadcast, notifications, the tray, opening a link) is
 * a port, and the connections come from `connect`, so the tests use a fake transport.
 *
 * Routing keys on the local stub id plus the remote workspace id, never on a task id alone: the
 * server's workspace ids are mapped to the stubs that link to them, and anything from a server
 * workspace no stub links to is dropped.
 */

/** The connection as the router uses it (`RemoteConnection`). */
export type Connection = Pick<
  RemoteConnection,
  'state' | 'connected' | 'start' | 'stop' | 'retryNow' | 'wake' | 'suspend' | 'request' | 'notify'
>

export interface RouterPorts {
  /** `experimental.remoteWorkspaces`, read fresh. */
  enabled(): boolean
  /** The local workspaces, stubs with their links included (`listWorkspaces`). */
  workspaces(): WorkspaceInfo[]
  activeWorkspaceId(): string
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

/** Where a call goes: the in-process host, or a remote workspace on a host. */
type Target =
  | { kind: 'local' }
  | { kind: 'disabled'; workspace: WorkspaceInfo }
  | { kind: 'remote'; workspace: WorkspaceInfo; link: RemoteWorkspaceLink; host: HostEntry }

/** The renderer's board reads and writes: they follow the active workspace. */
const ACTIVE_CHANNELS = new Set([
  'sources:providers',
  'sources:ghStatus',
  'sources:state',
  'sources:restTest',
  'sources:targets',
  'sources:sync',
  'sources:preview',
  'sources:apply',
  'sources:link',
  'sources:unlink',
  'sources:refresh',
  'tasks:list',
  'tasks:get',
  'tasks:problems',
  'tasks:removeWorktree',
  'tasks:create',
  'tasks:update',
  'tasks:note',
  'tasks:reorder',
  'tasks:archive',
  'tasks:delete',
  'tasks:forgetSession',
  'tasks:checkMerged',
  'git:branches',
  'git:taskDiff',
  'git:filePatch',
  'git:diffStats',
  'agents:list',
  'agents:remove',
  'agents:cliStatus',
  'worklog:load',
  'diagnostics:stop',
  'app:mcpCommand',
  'orchestrate:plan',
  'orchestrate:run',
  'orchestrate:autoState',
  'orchestrate:autoSet',
  'terminal:create',
  'terminal:launchAgent',
  'terminal:resumeSession',
  'terminal:previewPrompt',
  'terminal:createPr',
  'terminal:askReview',
  'terminal:gitContext',
  'terminal:listDirectories',
  'usage:claude'
])

/** Calls about one terminal session, whose id is the first argument: they go where it runs. */
const SESSION_CHANNELS = new Set([
  'terminal:kill',
  'terminal:backlog',
  'terminal:runtimeState',
  'terminal:askFork',
  'terminal:handOff',
  'usage:codex',
  'usage:context',
  'agent:conversation',
  'agent:prompt',
  'agent:approval'
])

/** Channels the router answers itself, merging local and remote, or acting locally on a remote path. */
const SPECIAL_CHANNELS = new Set([
  'workspaces:list',
  'workspaces:activity',
  'workspaces:boardSummary',
  'workspaces:switch',
  'workspaces:create',
  'workspaces:rename',
  'workspaces:delete',
  'settings:get',
  'settings:save',
  'settings:brokenFiles',
  'terminal:list',
  'diagnostics:snapshot',
  'tasks:reveal',
  'tasks:openInEditor',
  'terminal:openInCode',
  'terminal:revealDirectory'
])

/** Calls that change something. While a remote board is not live they are refused, never queued. */
const WRITE_CHANNELS = new Set([
  'tasks:removeWorktree',
  'tasks:create',
  'tasks:update',
  'tasks:note',
  'tasks:reorder',
  'tasks:archive',
  'tasks:delete',
  'tasks:forgetSession',
  'tasks:checkMerged',
  'sources:sync',
  'sources:apply',
  'sources:link',
  'sources:unlink',
  'sources:refresh',
  'agents:remove',
  'orchestrate:run',
  'orchestrate:autoSet',
  'terminal:create',
  'terminal:launchAgent',
  'terminal:resumeSession',
  'terminal:kill',
  'terminal:createPr',
  'terminal:askReview',
  'terminal:askFork',
  'terminal:handOff',
  'agent:prompt',
  'agent:approval'
])

/** Reads whose last answer is kept, so a disconnected board stays visible read-only. */
const SNAPSHOT_CHANNELS = new Set([
  'tasks:list',
  'tasks:get',
  'tasks:problems',
  'agents:list',
  'git:diffStats',
  'sources:state',
  'orchestrate:autoState',
  'worklog:load',
  'settings:get'
])

/** What a read answers with when it has no snapshot yet: an empty board, not an error. */
const OFFLINE_DEFAULTS: Record<string, () => unknown> = {
  'tasks:list': () => [],
  'tasks:get': () => null,
  'tasks:problems': () => [],
  'agents:list': () => [],
  'git:diffStats': () => ({}),
  'sources:state': () => ({})
}

/** Board broadcasts: from the local services they are dropped while a remote board is active. */
const BOARD_BROADCASTS = new Set([
  'tasks:changed',
  'agents:changed',
  'orchestrate:autoState',
  'orchestrate:autoStarted',
  'sources:state',
  'usage:claude'
])

/** Broadcasts addressed to one terminal session: forwarded from every host. */
const SESSION_BROADCASTS = new Set(['terminal:runtimeState', 'usage:context', 'agent:conversation'])

const SETTINGS_CHANGE = z.object({
  workspaceId: z.string().min(1),
  workspace: z.record(z.string(), z.unknown()),
  global: z.record(z.string(), z.unknown())
})

/** Sent before a reattach's backlog, so the view starts again rather than repeating itself. */
export const TERMINAL_RESET = '\x1bc'

/** Where a channel goes, for the coverage test against the server's table. */
export function channelRoute(channel: string): 'active' | 'session' | 'special' | 'local' {
  if (ACTIVE_CHANNELS.has(channel)) return 'active'
  if (SESSION_CHANNELS.has(channel)) return 'session'
  if (SPECIAL_CHANNELS.has(channel)) return 'special'
  return 'local'
}

interface HostEntry {
  host: string
  conn: Connection
  /** The server's own workspace list, for its active workspace, names and counts. */
  overview?: WorkspaceOverview
  /** The server's active workspace id, kept current from its broadcasts. */
  serverActiveId?: string
  /** Set from a `workspaces:changed` until the overview is fetched again: not live meanwhile. */
  overviewStale: boolean
  /** The server should switch to this remote workspace once connected (a user's switch). */
  wantSwitch?: string
  switching?: Promise<void>
  /** Why a remote workspace cannot be shown, by remote id. */
  errors: Map<string, string>
  /** The server's rollup and tray, mapped to stub ids; dropped while disconnected. */
  activity?: WorkspacesActivity['byWorkspace']
  tray?: { statuses: AgentStatus[]; titles: Map<string, string> }
  /** The next tray model is a baseline after a (re)connect: it raises no notification. */
  trayBaseline: boolean
  /** Sessions last listed on this host, kept for tabs while disconnected. */
  sessions: Map<string, TerminalSessionInfo>
  /** Terminals this client attached to, reattached on reconnect. */
  attached: Set<string>
  mirrors: Map<string, TerminalMirror>
  /** Output that arrived while an attach was on its way, applied after its backlog. */
  attaching: Map<string, TerminalOutput[]>
}

class RemoteUnavailable extends Error {}

export function createRemoteRouter(ports: RouterPorts) {
  const hosts = new Map<string, HostEntry>()
  const snapshots = new Map<string, unknown>()
  const sessionHosts = new Map<string, string>()
  const dataListeners = new Set<(id: string, output: TerminalOutput) => void>()
  const exitListeners = new Set<(id: string) => void>()
  let enabled = false
  let links = new Map<string, WorkspaceInfo & { remote: RemoteWorkspaceLink }>()
  let localActivity: WorkspacesActivity | undefined
  let localTray: { statuses: AgentStatus[]; titles: Map<string, string> } = {
    statuses: [],
    titles: new Map()
  }

  // ── Which workspaces are remote ──────────────────────────────────────────────────────────

  /**
   * Re-reads the flag and the stubs, and opens or closes host connections to match. Called at
   * start and whenever the local workspaces or settings change; with the flag off nothing
   * connects and no `ssh` runs.
   */
  function refresh(): void {
    const hadRemote = links.size > 0 || hosts.size > 0
    enabled = ports.enabled()
    links = new Map(
      ports
        .workspaces()
        .filter((w): w is WorkspaceInfo & { remote: RemoteWorkspaceLink } => Boolean(w.remote))
        .map((w) => [w.id, w])
    )
    const wanted = new Map<string, RemoteWorkspaceLink>()
    if (enabled)
      for (const w of links.values())
        if (!wanted.has(w.remote.host)) wanted.set(w.remote.host, w.remote)
    for (const [host, entry] of hosts) {
      if (wanted.has(host)) continue
      hosts.delete(host)
      entry.conn.stop()
      for (const id of entry.sessions.keys()) sessionHosts.delete(id)
    }
    for (const [host, link] of wanted) {
      if (hosts.has(host)) continue
      const entry: HostEntry = {
        host,
        conn: undefined as unknown as Connection,
        overviewStale: false,
        errors: new Map(),
        trayBaseline: true,
        sessions: new Map(),
        attached: new Set(),
        mirrors: new Map(),
        attaching: new Map()
      }
      entry.conn = ports.connect(host, link, connectionEvents(entry))
      hosts.set(host, entry)
      const active = links.get(ports.activeWorkspaceId())
      if (active?.remote.host === host) entry.wantSwitch = active.remote.workspaceId
      entry.conn.start()
    }
    for (const key of [...snapshots.keys()]) {
      if (!links.has(key.slice(0, key.indexOf('\0')))) snapshots.delete(key)
    }
    // With no remote workspace before or after, nothing is broadcast: the app is as it was.
    if (!hadRemote && links.size === 0) return
    emitTray()
    emitActivity()
    emitState()
  }

  function target(workspaceId: string = ports.activeWorkspaceId()): Target {
    const workspace = links.get(workspaceId)
    if (!workspace) return { kind: 'local' }
    if (!enabled) return { kind: 'disabled', workspace }
    const host = hosts.get(workspace.remote.host)
    if (!host) return { kind: 'disabled', workspace }
    return { kind: 'remote', workspace, link: workspace.remote, host }
  }

  /** Connected, and the server shows this workspace: its board is live and writable. */
  function isLive(t: Extract<Target, { kind: 'remote' }>): boolean {
    const entry = t.host
    return (
      entry.conn.connected &&
      !entry.overviewStale &&
      !entry.switching &&
      entry.serverActiveId === t.link.workspaceId
    )
  }

  function activeRemote(): Extract<Target, { kind: 'remote' }> | undefined {
    const t = target()
    return t.kind === 'remote' ? t : undefined
  }

  /** The stub linking to `serverId` on `host`, if any. */
  function stubFor(
    host: string,
    serverId: string
  ): (WorkspaceInfo & { remote: RemoteWorkspaceLink }) | undefined {
    for (const w of links.values())
      if (w.remote.host === host && w.remote.workspaceId === serverId) return w
    return undefined
  }

  /**
   * A value from a server with its `workspaceId`s turned into the stubs' ids. A workspace no stub
   * links to gets a marker id that matches no local workspace, so it shows nowhere.
   */
  function mapIn(host: string, value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => mapIn(host, item))
    if (!value || typeof value !== 'object') return value
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        key === 'workspaceId' && typeof item === 'string'
          ? localIdFor(host, item)
          : mapIn(host, item)
    }
    return out
  }

  function localIdFor(host: string, serverId: string): string {
    return stubFor(host, serverId)?.id ?? `${UNLINKED}${host}/${serverId}`
  }

  // ── Calls ───────────────────────────────────────────────────────────────────────────────

  /**
   * Answers one invoke call; `local` runs the in-process handler. With no remote workspace at
   * all, it is the handler itself, called synchronously as before.
   */
  function invoke(channel: string, args: unknown[], local: () => unknown): unknown {
    if (!enabled && links.size === 0) return local()
    return route(channel, args, local)
  }

  async function route(channel: string, args: unknown[], local: () => unknown): Promise<unknown> {
    switch (channel) {
      case 'workspaces:list':
        return mergeOverview((await local()) as WorkspaceOverview)
      case 'workspaces:activity':
        return mergedActivity()
      case 'workspaces:boardSummary':
        return mergeSummaries((await local()) as Record<string, WorkspaceBoardSummary>)
      case 'workspaces:switch':
        return switchTo(String(args[0]), local)
      case 'workspaces:create':
      case 'workspaces:rename':
      case 'workspaces:delete': {
        const overview = (await local()) as WorkspaceOverview
        refresh()
        return mergeOverview(overview)
      }
      case 'settings:get':
        return settingsFor(typeof args[0] === 'string' ? args[0] : undefined, local)
      case 'settings:save':
        return saveSettings(args[0], local)
      case 'settings:brokenFiles':
        return brokenSettingsFiles((await local()) as BrokenSettingsFile[])
      case 'terminal:list':
        return listTerminals((await local()) as TerminalSessionInfo[])
      case 'diagnostics:snapshot': {
        const t = target()
        if (t.kind !== 'remote') return local()
        const [remote, mine] = await Promise.all([forward(t, channel, args), local()])
        // The terminal engine draws on this machine, so its diagnostics are this machine's.
        return {
          ...(remote as object),
          terminalEngine: (mine as { terminalEngine?: unknown }).terminalEngine
        }
      }
      case 'tasks:reveal':
        // A remote file has no place in this machine's file manager.
        return target().kind === 'local' ? local() : undefined
      case 'tasks:openInEditor':
        return openInEditor(String(args[0]), local)
      case 'terminal:openInCode': {
        const t = activeRemote()
        if (!t) return local()
        ports.openExternal(remoteEditorUri('vscode', t.link.host, String(args[0])))
        return 'code'
      }
      case 'terminal:revealDirectory': {
        const t = activeRemote()
        return t ? `This folder is on ${t.link.host}.` : local()
      }
    }
    if (SESSION_CHANNELS.has(channel)) {
      const entry = sessionHost(String(args[0]))
      if (!entry) return local()
      if (channel === 'terminal:backlog') return attachTerminal(entry, String(args[0]))
      return forwardToHost(entry, channel, args)
    }
    if (!ACTIVE_CHANNELS.has(channel)) return local()
    const t = target()
    if (t.kind === 'local') return local()
    if (t.kind === 'disabled') {
      if (WRITE_CHANNELS.has(channel)) throw new Error(disabledMessage(t.workspace))
      return OFFLINE_DEFAULTS[channel]?.() ?? local()
    }
    return forward(t, channel, args)
  }

  /** A one-way call (`terminal:write`, `terminal:resize`): sent where the session runs, or dropped. */
  function send(channel: string, args: unknown[], local: () => void): void {
    if (channel !== 'terminal:write' && channel !== 'terminal:resize') return local()
    const id = String(args[0])
    const entry = sessionHost(id)
    if (!entry) return local()
    entry.conn.notify(channel, args)
    // The PTY takes the size of the client that focused it last; resizing is what a view does
    // when it is shown, so it counts as focusing.
    if (channel === 'terminal:resize') entry.conn.notify('terminal:focus', [id])
  }

  async function forward(
    t: Extract<Target, { kind: 'remote' }>,
    channel: string,
    args: unknown[]
  ): Promise<unknown> {
    if (t.host.switching) await t.host.switching
    const key = snapshotKey(t.workspace.id, channel, args)
    if (!isLive(t)) {
      if (WRITE_CHANNELS.has(channel)) throw new RemoteUnavailable(unavailableMessage(t))
      if (snapshots.has(key)) return snapshots.get(key)
      const fallback = OFFLINE_DEFAULTS[channel]
      if (fallback) return fallback()
      throw new RemoteUnavailable(unavailableMessage(t))
    }
    try {
      const result = mapIn(t.link.host, await t.host.conn.request(channel, args))
      if (SNAPSHOT_CHANNELS.has(channel)) snapshots.set(key, result)
      recordSessions(t.host, channel, result)
      return result
    } catch (error) {
      if (!WRITE_CHANNELS.has(channel) && snapshots.has(key) && !t.host.conn.connected) {
        return snapshots.get(key)
      }
      throw error
    }
  }

  async function forwardToHost(
    entry: HostEntry,
    channel: string,
    args: unknown[]
  ): Promise<unknown> {
    if (!entry.conn.connected) {
      if (WRITE_CHANNELS.has(channel)) {
        throw new RemoteUnavailable(`${entry.host} is not connected. Nothing was sent or queued.`)
      }
      return channel === 'terminal:runtimeState' ? undefined : null
    }
    const result = mapIn(entry.host, await entry.conn.request(channel, args))
    recordSessions(entry, channel, result)
    return result
  }

  function snapshotKey(stubId: string, channel: string, args: unknown[]): string {
    return `${stubId}\0${channel}\0${JSON.stringify(args)}`
  }

  function unavailableMessage(t: Extract<Target, { kind: 'remote' }>): string {
    const name = t.workspace.name
    const error = t.host.errors.get(t.link.workspaceId)
    if (error) return `${name} cannot be shown: ${error}`
    if (!t.host.conn.connected) {
      return `${name} is offline while Styr reconnects to ${t.link.host}. Nothing was changed or queued.`
    }
    const elsewhere = elsewhereName(t.host, t.link.workspaceId)
    if (elsewhere) return `${t.link.host} is showing “${elsewhere}”. Switch back to make changes.`
    return `${name} is still loading from ${t.link.host}. Try again in a moment.`
  }

  function disabledMessage(workspace: WorkspaceInfo): string {
    return `${workspace.name} is a remote workspace, and remote workspaces are off. Turn them on in Settings → Experimental.`
  }

  // ── Terminals ───────────────────────────────────────────────────────────────────────────

  /** The host a session runs on: one it was seen on, else the active remote workspace's host. */
  function sessionHost(id: string): HostEntry | undefined {
    if (!enabled || ports.isLocalSession(id)) return undefined
    const known = sessionHosts.get(id)
    if (known) return hosts.get(known)
    return activeRemote()?.host
  }

  function isRemoteSession(id: string): boolean {
    return sessionHost(id) !== undefined
  }

  /** Remembers the host of every session a call returned, and tags each with it. */
  function recordSessions(entry: HostEntry, channel: string, result: unknown): void {
    const sessions: TerminalSessionInfo[] = []
    if (channel === 'orchestrate:run' && Array.isArray(result)) {
      for (const item of result) if (item?.session) sessions.push(item.session)
    } else if (
      [
        'terminal:create',
        'terminal:launchAgent',
        'terminal:resumeSession',
        'terminal:askReview',
        'terminal:askFork'
      ].includes(channel) &&
      result &&
      typeof result === 'object'
    ) {
      sessions.push(result as TerminalSessionInfo)
    }
    for (const session of sessions) tagSession(entry, session)
  }

  function tagSession(entry: HostEntry, session: TerminalSessionInfo): void {
    session.host = entry.host
    sessionHosts.set(session.id, entry.host)
    entry.sessions.set(session.id, session)
  }

  /** This machine's sessions, then each host's: the live list, or the last one while disconnected. */
  async function listTerminals(local: TerminalSessionInfo[]): Promise<TerminalSessionInfo[]> {
    if (!enabled) return local
    const remote = await Promise.all(
      [...hosts.values()].map(async (entry) => {
        if (entry.conn.connected) {
          try {
            const listed = mapIn(
              entry.host,
              await entry.conn.request('terminal:list')
            ) as TerminalSessionInfo[]
            entry.sessions.clear()
            for (const session of listed) {
              if (session.workspaceId?.startsWith(UNLINKED)) continue
              tagSession(entry, session)
            }
          } catch {
            // Keep the last list.
          }
        }
        return [...entry.sessions.values()]
      })
    )
    return [...local, ...remote.flat()]
  }

  /**
   * `terminal:backlog` for a remote session: attaches this client to its stream and returns the
   * server's backlog, keeping a mirror for the Styr Terminal engine. While disconnected, the last
   * mirror (or nothing) is shown; the reattach on reconnect brings it up to date.
   */
  async function attachTerminal(entry: HostEntry, id: string): Promise<TerminalOutput> {
    if (!entry.conn.connected) {
      entry.attached.add(id)
      return entry.mirrors.get(id)?.backlog() ?? { data: '', sequence: 0, marks: [] }
    }
    entry.attaching.set(id, [])
    try {
      const backlog = (await entry.conn.request('terminal:attach', [id])) as TerminalOutput
      entry.attached.add(id)
      entry.mirrors.set(id, new TerminalMirror(backlog))
      flushEarly(entry, id)
      return backlog
    } finally {
      entry.attaching.delete(id)
    }
  }

  /**
   * Output that arrived while an attach was on its way, held back by `terminalData`: a line read
   * in the same chunk as the attach's reply is dispatched before the `await` resumes. Sent now,
   * after the backlog, skipping what the backlog already held.
   */
  function flushEarly(entry: HostEntry, id: string): void {
    const early = entry.attaching.get(id) ?? []
    entry.attaching.delete(id)
    const mirror = entry.mirrors.get(id)
    for (const output of early.sort((a, b) => a.sequence - b.sequence)) {
      if (mirror && !mirror.append(output)) continue
      for (const listener of dataListeners) listener(id, output)
      ports.broadcast('terminal:data', { id, ...output })
    }
  }

  /** The mirror's backlog for a remote session, for the engine's synchronous `backlog` port. */
  function mirrorBacklog(id: string): TerminalOutput | undefined {
    const host = sessionHosts.get(id)
    return host ? hosts.get(host)?.mirrors.get(id)?.backlog() : undefined
  }

  /** Makes sure a remote session is attached and mirrored (the engine's attach). */
  async function ensureAttached(id: string): Promise<void> {
    const entry = sessionHost(id)
    if (entry && !entry.mirrors.has(id)) await attachTerminal(entry, id)
  }

  function terminalData(entry: HostEntry, payload: { id: string } & TerminalOutput): void {
    const { id, ...output } = payload
    sessionHosts.set(id, entry.host)
    const early = entry.attaching.get(id)
    // Held until the attach's backlog is in place (`flushEarly`), so a reset cannot wipe it.
    if (early) return void early.push(output)
    entry.mirrors.get(id)?.append(output)
    for (const listener of dataListeners) listener(id, output)
    ports.broadcast('terminal:data', payload)
  }

  function terminalExit(entry: HostEntry, payload: { id: string; exitCode: number }): void {
    forgetSession(entry, payload.id)
    for (const listener of exitListeners) listener(payload.id)
    ports.broadcast('terminal:exit', payload)
  }

  function forgetSession(entry: HostEntry, id: string): void {
    sessionHosts.delete(id)
    entry.sessions.delete(id)
    entry.attached.delete(id)
    entry.mirrors.delete(id)
  }

  /**
   * Reattaches every terminal this client had open: what ran meanwhile arrives as the server's
   * backlog, written after a reset so the view does not repeat what it already showed. A session
   * the server no longer has (it restarted) is reported exited, as after an app restart.
   */
  async function reattach(entry: HostEntry): Promise<void> {
    if (entry.attached.size === 0) return
    let live: Set<string>
    try {
      const listed = (await entry.conn.request('terminal:list')) as TerminalSessionInfo[]
      live = new Set(listed.map((session) => session.id))
    } catch {
      return
    }
    for (const id of [...entry.attached]) {
      if (!live.has(id)) {
        terminalExit(entry, { id, exitCode: -1 })
        continue
      }
      entry.attaching.set(id, [])
      try {
        const backlog = (await entry.conn.request('terminal:attach', [id])) as TerminalOutput
        const mirror = entry.mirrors.get(id)
        if (mirror && backlog.sequence <= mirror.lastSequence) {
          flushEarly(entry, id)
          continue
        }
        if (mirror) mirror.reset(backlog)
        else entry.mirrors.set(id, new TerminalMirror(backlog))
        const output: TerminalOutput = {
          data: TERMINAL_RESET + backlog.data,
          sequence: backlog.sequence,
          marks: backlog.marks.map((mark) => ({
            ...mark,
            offset: mark.offset + TERMINAL_RESET.length
          }))
        }
        for (const listener of dataListeners) listener(id, output)
        ports.broadcast('terminal:data', { id, ...output })
        flushEarly(entry, id)
      } catch {
        // Left detached; the next reconnect tries again.
      } finally {
        entry.attaching.delete(id)
      }
    }
  }

  // ── Workspaces ──────────────────────────────────────────────────────────────────────────

  async function switchTo(id: string, local: () => unknown): Promise<WorkspaceOverview> {
    const t = target(id)
    if (t.kind === 'disabled') throw new Error(disabledMessage(t.workspace))
    const overview = (await local()) as WorkspaceOverview
    if (t.kind === 'remote') requestServerSwitch(t)
    else emitState()
    return mergeOverview(overview)
  }

  /**
   * Points the server at this workspace: its active workspace follows the most recent client to
   * switch (TASK-0131). Until connected, the switch waits; the board refreshes once it is done.
   */
  function requestServerSwitch(t: Extract<Target, { kind: 'remote' }>): void {
    const entry = t.host
    entry.wantSwitch = t.link.workspaceId
    if (!entry.conn.connected) return emitState()
    const remoteId = t.link.workspaceId
    entry.wantSwitch = undefined
    const switching = entry.conn
      .request('workspaces:switch', [remoteId])
      .then((overview) => {
        setOverview(entry, overview as WorkspaceOverview)
        entry.errors.delete(remoteId)
      })
      .catch((error: unknown) => {
        entry.errors.set(remoteId, error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (entry.switching === switching) entry.switching = undefined
        emitState()
        if (activeRemote()?.host === entry) refreshBoard(entry)
      })
    entry.switching = switching
    emitState()
  }

  function setOverview(entry: HostEntry, overview: WorkspaceOverview): void {
    entry.overview = overview
    entry.serverActiveId = overview.activeId
    entry.overviewStale = false
  }

  async function fetchOverview(entry: HostEntry): Promise<void> {
    try {
      setOverview(entry, (await entry.conn.request('workspaces:list')) as WorkspaceOverview)
    } catch {
      entry.overviewStale = false
    }
  }

  function elsewhereName(entry: HostEntry, remoteId: string): string | undefined {
    if (!entry.conn.connected || !entry.serverActiveId || entry.serverActiveId === remoteId) {
      return undefined
    }
    const other = entry.overview?.workspaces.find((w) => w.id === entry.serverActiveId)
    return other?.name ?? entry.serverActiveId
  }

  /** Stubs take their task and session counts from the server's list when it is known. */
  function mergeOverview(overview: WorkspaceOverview): WorkspaceOverview {
    return {
      ...overview,
      workspaces: overview.workspaces.map((workspace) => {
        const link = links.get(workspace.id)?.remote
        if (!link) return workspace
        const remote = hosts
          .get(link.host)
          ?.overview?.workspaces.find((w) => w.id === link.workspaceId)
        return {
          ...workspace,
          remote: link,
          taskCount: remote?.taskCount ?? 0,
          liveSessions: remote?.liveSessions ?? 0
        }
      })
    }
  }

  async function mergeSummaries(
    local: Record<string, WorkspaceBoardSummary>
  ): Promise<Record<string, WorkspaceBoardSummary>> {
    const merged = { ...local }
    for (const id of links.keys()) delete merged[id]
    if (!enabled) return merged
    await Promise.all(
      [...hosts.values()].map(async (entry) => {
        if (!entry.conn.connected) return
        try {
          const remote = (await entry.conn.request('workspaces:boardSummary')) as Record<
            string,
            WorkspaceBoardSummary
          >
          for (const [serverId, summary] of Object.entries(remote)) {
            const stub = stubFor(entry.host, serverId)
            if (stub) merged[stub.id] = summary
          }
        } catch {
          // The menu shows the agent state alone.
        }
      })
    )
    return merged
  }

  // ── Settings ────────────────────────────────────────────────────────────────────────────

  /**
   * A remote workspace's settings: its own keys from the server, the app-level keys from this
   * machine (storage, shortcuts, updates, experimental and the active workspace never sync).
   */
  async function settingsFor(
    workspaceId: string | undefined,
    local: () => unknown
  ): Promise<Settings> {
    const mine = (await local()) as Settings
    const t = target(workspaceId)
    if (t.kind !== 'remote') return mine
    const key = snapshotKey(t.workspace.id, 'settings:get', [])
    let remote: Settings | undefined
    if (t.host.conn.connected) {
      try {
        remote = (await t.host.conn.request('settings:get', [t.link.workspaceId])) as Settings
        snapshots.set(key, remote)
      } catch {
        // Fall back to the last one.
      }
    }
    remote ??= snapshots.get(key) as Settings | undefined
    return remote ? { ...remote, ...globalSettingsFor(mine) } : mine
  }

  /**
   * A Save from the dialog: the app-level part is written here, the workspace part on the server,
   * with the server's own app-level settings sent back unchanged.
   */
  async function saveSettings(change: unknown, local: () => unknown): Promise<Settings> {
    // Only its shape: each side validates its own part (`saveGlobalSettings`, the server's save).
    const parsed = SETTINGS_CHANGE.parse(change) as {
      workspaceId: string
      workspace: Partial<Settings>
      global: GlobalSettings
    }
    const t = target(parsed.workspaceId)
    if (t.kind === 'disabled') throw new Error(disabledMessage(t.workspace))
    if (t.kind === 'local') {
      await local()
      return settingsFor(undefined, loadedSettings)
    }
    ports.saveGlobalSettings(parsed.global)
    if (!t.host.conn.connected) {
      throw new RemoteUnavailable(
        `The app settings were saved, but ${t.workspace.name}'s own were not: ${t.link.host} is not connected.`
      )
    }
    const current = (await t.host.conn.request('settings:get', [t.link.workspaceId])) as Settings
    await t.host.conn.request('settings:save', [
      {
        workspaceId: t.link.workspaceId,
        workspace: parsed.workspace,
        global: globalSettingsFor(current)
      }
    ])
    return settingsFor(undefined, loadedSettings)
  }

  /** Set by the caller (`bindSettings`), so the router reads settings the way main does. */
  let loadedSettings: () => Settings = () => {
    throw new Error('Remote router: settings are not bound.')
  }

  /** Settings files that do not parse, here and on each connected server (its paths are shown only). */
  async function brokenSettingsFiles(local: BrokenSettingsFile[]): Promise<BrokenSettingsFile[]> {
    const merged = local.filter((file) => !links.has(file.workspaceId))
    if (!enabled) return merged
    for (const entry of hosts.values()) {
      if (!entry.conn.connected) continue
      try {
        const files = (await entry.conn.request('settings:brokenFiles')) as BrokenSettingsFile[]
        for (const file of files) {
          const stub = stubFor(entry.host, file.workspaceId)
          if (stub) merged.push({ ...file, workspaceId: stub.id })
        }
      } catch {
        // Settings shows the local files alone.
      }
    }
    return merged
  }

  // ── Opening files ───────────────────────────────────────────────────────────────────────

  /**
   * A remote task file opens in VS Code or Cursor over ssh (`vscode://vscode-remote/…`); any other
   * editor cannot reach it, so nothing happens (the renderer disables the button and names the
   * remote path). The path is passed on as text, never resolved here.
   */
  async function openInEditor(id: string, local: () => unknown): Promise<void> {
    const t = target()
    if (t.kind === 'local') {
      await local()
      return
    }
    if (t.kind !== 'remote') return
    const task = (await forward(t, 'tasks:get', [id])) as Task | null
    const settings = await settingsFor(undefined, loadedSettings)
    const editor = remoteEditorFor(settings.openFilesWith)
    if (task && editor) ports.openExternal(remoteEditorUri(editor, t.link.host, task.filePath))
  }

  // ── Events from the servers ─────────────────────────────────────────────────────────────

  function connectionEvents(entry: HostEntry): ConnectionEvents {
    return {
      state: () => emitState(),
      connected: (hello, reconnect) => void onConnected(entry, hello, reconnect),
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
  async function onConnected(
    entry: HostEntry,
    _hello: ServerHello,
    reconnect: boolean
  ): Promise<void> {
    await fetchOverview(entry)
    if (!reconnect && !entry.wantSwitch) {
      const active = links.get(ports.activeWorkspaceId())
      if (active?.remote.host === entry.host) entry.wantSwitch = active.remote.workspaceId
    }
    const wanted = entry.wantSwitch
    const active = activeRemote()
    if (wanted && active?.host === entry && active.link.workspaceId === wanted)
      requestServerSwitch(active)
    entry.wantSwitch = undefined
    entry.trayBaseline = true
    await Promise.all([
      reattach(entry),
      entry.conn.request('workspaces:activity').then(
        (activity) => setActivity(entry, activity as WorkspacesActivity),
        () => undefined
      ),
      entry.conn.request('server:tray').then(
        (tray) => setTray(entry, tray),
        () => undefined
      )
    ])
    emitState()
    if (activeRemote()?.host === entry && !entry.switching) refreshBoard(entry)
    ports.broadcast('workspaces:changed')
  }

  function onDisconnected(entry: HostEntry): void {
    entry.activity = undefined
    entry.tray = undefined
    entry.attaching.clear()
    emitTray()
    emitActivity()
    emitState()
  }

  /** Tells the renderer to fetch the board again, now that the server shows it. */
  function refreshBoard(entry: HostEntry): void {
    ports.broadcast('tasks:changed')
    emitSettings()
    const t = activeRemote()
    if (!t || t.host !== entry || !isLive(t)) {
      ports.broadcast('agents:changed', [])
      return
    }
    void forward(t, 'agents:list', []).then(
      (agents) => ports.broadcast('agents:changed', agents),
      () => undefined
    )
    void forward(t, 'orchestrate:autoState', []).then(
      (state) => ports.broadcast('orchestrate:autoState', state),
      () => undefined
    )
  }

  function onNotification(entry: HostEntry, method: string, params: unknown[]): void {
    const payload = params[0]
    switch (method) {
      case 'terminal:data':
        return terminalData(entry, payload as { id: string } & TerminalOutput)
      case 'terminal:exit':
        return terminalExit(entry, payload as { id: string; exitCode: number })
      case 'server:tray':
        setTray(entry, payload)
        return
      case 'server:notify': {
        // Raised from the live stream only: nothing that happened while disconnected is backfilled.
        const { title, body } = (payload ?? {}) as { title?: unknown; body?: unknown }
        ports.notify(String(title ?? 'Styr'), `${entry.host} · ${String(body ?? '')}`)
        return
      }
      case 'workspaces:activity':
        setActivity(entry, payload as WorkspacesActivity)
        return
      case 'workspaces:changed':
        entry.overviewStale = true
        void fetchOverview(entry).then(() => {
          emitState()
          ports.broadcast('workspaces:changed')
        })
        return
      case 'settings:changed': {
        const serverActive = (payload as Settings | undefined)?.activeWorkspaceId
        if (serverActive) entry.serverActiveId = serverActive
        emitState()
        if (activeOnLive(entry)) emitSettings()
        return
      }
    }
    if (SESSION_BROADCASTS.has(method)) {
      ports.broadcast(method, mapIn(entry.host, payload))
      return
    }
    if (BOARD_BROADCASTS.has(method) && activeOnLive(entry)) {
      const mapped = mapIn(entry.host, payload)
      if (method === 'orchestrate:autoStarted' && mapped && typeof mapped === 'object') {
        tagSession(entry, mapped as TerminalSessionInfo)
      }
      if (params.length === 0) ports.broadcast(method)
      else ports.broadcast(method, mapped)
    }
  }

  function activeOnLive(entry: HostEntry): boolean {
    const t = activeRemote()
    return t !== undefined && t.host === entry && isLive(t)
  }

  // ── Broadcasts from this machine's services ─────────────────────────────────────────────

  /**
   * Every broadcast the local services make passes through here. While a remote board is active
   * the local board's events are dropped (the server's take their place), the rollup is merged,
   * and a change to the workspaces or settings re-reads which workspaces are remote.
   */
  function fromLocal(channel: string, payload?: unknown): void {
    if (channel === 'workspaces:activity') {
      localActivity = payload as WorkspacesActivity
      if (links.size === 0 && hosts.size === 0) return ports.broadcast(channel, payload)
      emitActivity()
      return
    }
    if (channel === 'workspaces:changed' || channel === 'settings:changed') refresh()
    // A remote board's settings are the server's, with this machine's app-level keys laid over.
    if (channel === 'settings:changed' && activeRemote()) return emitSettings()
    // Checked first: terminal data passes through here on every chunk.
    const t = BOARD_BROADCASTS.has(channel) ? target() : undefined
    if (t?.kind === 'remote') {
      if (isLive(t)) return
      // Offline, the board is the last snapshot: the local stub's empty agent list must not
      // replace it, but a request to refetch is harmless.
      if (channel === 'agents:changed') {
        const key = snapshotKey(t.workspace.id, 'agents:list', [])
        return ports.broadcast('agents:changed', snapshots.get(key) ?? [])
      }
      if (channel !== 'tasks:changed') return
    }
    if (payload === undefined) ports.broadcast(channel)
    else ports.broadcast(channel, payload)
  }

  function emitSettings(): void {
    void settingsFor(undefined, loadedSettings).then(
      (settings) => ports.broadcast('settings:changed', settings),
      () => undefined
    )
  }

  // ── The rollup and the tray ─────────────────────────────────────────────────────────────

  function setActivity(entry: HostEntry, activity: WorkspacesActivity | undefined): void {
    const byWorkspace: WorkspacesActivity['byWorkspace'] = {}
    for (const [serverId, value] of Object.entries(activity?.byWorkspace ?? {})) {
      const stub = stubFor(entry.host, serverId)
      if (stub) byWorkspace[stub.id] = value
    }
    entry.activity = byWorkspace
    emitActivity()
  }

  function mergedActivity(): WorkspacesActivity {
    const byWorkspace = { ...(localActivity?.byWorkspace ?? {}) }
    for (const id of links.keys()) delete byWorkspace[id]
    if (enabled)
      for (const entry of hosts.values()) Object.assign(byWorkspace, entry.activity ?? {})
    return { activeId: localActivity?.activeId ?? ports.activeWorkspaceId(), byWorkspace }
  }

  function emitActivity(): void {
    if (!localActivity && hosts.size === 0) return
    ports.broadcast('workspaces:activity', mergedActivity())
  }

  /** The server's tray model, re-tagged with the stubs' ids and names; others are dropped. */
  function setTray(entry: HostEntry, payload: unknown): void {
    const { statuses = [], titles = {} } = (payload ?? {}) as {
      statuses?: AgentStatus[]
      titles?: Record<string, string>
    }
    const mapped: AgentStatus[] = []
    const mappedTitles = new Map<string, string>()
    for (const status of statuses) {
      const stub = status.workspaceId ? stubFor(entry.host, status.workspaceId) : undefined
      if (!stub) continue
      const local = { ...status, workspaceId: stub.id, workspaceName: stub.name }
      mapped.push(local)
      const title = titles[agentKey(status)]
      if (title) mappedTitles.set(agentKey(local), title)
    }
    entry.tray = { statuses: mapped, titles: mappedTitles }
    emitTray()
  }

  /** The local model, as the agents service built it, merged with every connected server's. */
  function localTrayChanged(statuses: AgentStatus[], titles: Map<string, string>): void {
    localTray = { statuses, titles }
    if (links.size === 0 && hosts.size === 0) return ports.updateTray(statuses, titles, new Set())
    emitTray()
  }

  function emitTray(): void {
    const stubIds = new Set(links.keys())
    const statuses = localTray.statuses.filter((s) => !s.workspaceId || !stubIds.has(s.workspaceId))
    const titles = new Map(localTray.titles)
    const quiet = new Set<string>()
    if (enabled) {
      for (const entry of hosts.values()) {
        if (!entry.tray) continue
        statuses.push(...entry.tray.statuses)
        for (const [key, title] of entry.tray.titles) titles.set(key, title)
        if (entry.trayBaseline) {
          // What changed while disconnected is shown, not announced.
          for (const status of entry.tray.statuses) quiet.add(agentKey(status))
          entry.trayBaseline = false
        }
      }
    }
    ports.updateTray(statuses, titles, quiet)
  }

  // ── State for the renderer ──────────────────────────────────────────────────────────────

  function state(): RemoteState {
    const workspaces: Record<string, RemoteWorkspaceState> = {}
    for (const w of links.values()) {
      const entry = hosts.get(w.remote.host)
      const t = target(w.id)
      const elsewhere = entry ? elsewhereName(entry, w.remote.workspaceId) : undefined
      const error = entry?.errors.get(w.remote.workspaceId)
      workspaces[w.id] = {
        host: w.remote.host,
        remoteWorkspaceId: w.remote.workspaceId,
        live: t.kind === 'remote' && isLive(t),
        ...(elsewhere && !entry?.switching ? { elsewhere } : {}),
        ...(error ? { error } : {})
      }
    }
    const hostStates: RemoteHostState[] = [...hosts.values()].map((entry) => {
      const server = entry.overview?.workspaces.find((w) => w.id === entry.serverActiveId)
      return {
        ...entry.conn.state(),
        ...(entry.conn.connected && entry.serverActiveId
          ? {
              serverWorkspace: {
                id: entry.serverActiveId,
                name: server?.name ?? entry.serverActiveId
              }
            }
          : {})
      }
    })
    return { enabled, hosts: hostStates, workspaces }
  }

  function emitState(): void {
    ports.broadcast('remote:state', state())
  }

  return {
    refresh,
    invoke,
    send,
    fromLocal,
    localTrayChanged,
    state,
    isRemoteSession,
    mirrorBacklog,
    ensureAttached,
    onTerminalData: (listener: (id: string, output: TerminalOutput) => void) =>
      dataListeners.add(listener),
    onTerminalExit: (listener: (id: string) => void) => exitListeners.add(listener),
    /** How the router loads this machine's settings for the active workspace. */
    bindSettings(load: () => Settings): void {
      loadedSettings = load
    },
    /** "Retry now" for one host, or every host (the network came back). */
    retry(host?: string): void {
      for (const entry of hosts.values()) if (!host || entry.host === host) entry.conn.retryNow()
    },
    /** "Switch back": the server shows this workspace again. */
    switchBack(stubId: string): void {
      const t = target(stubId)
      if (t.kind === 'remote') requestServerSwitch(t)
    },
    /** The machine woke: every link is replaced, since one that slept may be dead. */
    wake(): void {
      for (const entry of hosts.values()) entry.conn.wake(true)
    },
    suspend(): void {
      for (const entry of hosts.values()) entry.conn.suspend('The computer went to sleep.')
    },
    stopAll(): void {
      for (const entry of hosts.values()) entry.conn.stop()
      hosts.clear()
    }
  }
}

/** The id given to a server workspace no stub links to: it matches no local workspace. */
export const UNLINKED = 'remote-unlinked:'

export type RemoteRouter = ReturnType<typeof createRemoteRouter>
