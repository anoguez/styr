import { createContext, useContext } from 'react'
import { remoteEditorFor } from '@core/remote.js'
import type {
  RemoteHostState,
  RemoteRunningAgents,
  RemoteState,
  RemoteTransfer,
  RemoteWorkspaceState,
  TerminalSessionInfo,
  WorkspaceInfo
} from '@core/types.js'

/**
 * What the renderer shows of remote workspaces (`docs/architecture/remote.md`): whether the open
 * board is live or a read-only snapshot, and why, and how each workspace and terminal reads. Pure,
 * so the wording is tested without a window.
 */

export const NO_REMOTE: RemoteState = { enabled: false, hosts: [], workspaces: {} }

/** The open board's access: a local or live remote board is writable; anything else is not. */
export interface BoardAccess {
  /** Set while the open workspace is remote. */
  remote?: RemoteWorkspaceState
  host?: RemoteHostState
  readOnly: boolean
  /** Why writes are off, for their tooltips. */
  reason?: string
}

export function boardAccess(state: RemoteState, activeId: string): BoardAccess {
  const remote = state.workspaces[activeId]
  if (!remote) return { readOnly: false }
  const host = state.hosts.find((entry) => entry.host === remote.host)
  if (!state.enabled) {
    return {
      remote,
      readOnly: true,
      reason: 'Remote workspaces are off (Settings → Experimental).'
    }
  }
  if (remote.live) return { remote, host, readOnly: false }
  return { remote, host, readOnly: true, reason: notLiveReason(remote, host) }
}

function notLiveReason(remote: RemoteWorkspaceState, host?: RemoteHostState): string {
  if (remote.error) return `This workspace cannot be shown: ${remote.error}`
  if (host?.status === 'incompatible') {
    return `Read-only: ${remote.host} runs a server this app cannot talk to. Upgrade the server to make changes.`
  }
  if (host?.userDisconnected) {
    return `Read-only: you disconnected ${remote.host}. Connect it again in Settings → Remote hosts.`
  }
  if (!host || host.status !== 'connected') {
    return `Read-only while ${remote.host} is disconnected. Nothing is queued.`
  }
  if (remote.elsewhere) {
    return `Read-only: ${remote.host} is showing “${remote.elsewhere}”. Switch back to make changes.`
  }
  return `Loading from ${remote.host}…`
}

/** The badge's short label for a host's connection. */
export function connectionLabel(host?: RemoteHostState): string {
  switch (host?.status) {
    case 'connected':
      return host.host
    case 'connecting':
      return `Connecting to ${host.host}…`
    case 'reconnecting':
      return 'Reconnecting…'
    case 'offline':
      return host.userDisconnected ? `${host.host} disconnected` : `${host.host} offline`
    case 'incompatible':
      return `${host.host} needs a server upgrade`
    default:
      return 'Not connected'
  }
}

/** How long a server has run, from its `startedAt`: "3d 4h", "2h 5m", "12m", "under a minute". */
export function uptime(startedAt: string | undefined, now: number): string | undefined {
  const start = startedAt ? Date.parse(startedAt) : NaN
  if (Number.isNaN(start)) return undefined
  const minutes = Math.max(0, Math.floor((now - start) / 60_000))
  if (minutes < 1) return 'under a minute'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

/** How the server reached the host, as setup reports it. */
export function transferLabel(transfer: RemoteTransfer): string {
  switch (transfer) {
    case 'download':
      return 'The host downloaded the server from the GitHub release.'
    case 'upload':
      return 'The host could not download the server, so this computer uploaded it over ssh.'
    case 'installed':
      return 'This server version was already installed on the host.'
    case 'running':
      return 'A server of this version was already running on the host; it is shared.'
  }
}

/**
 * The confirmation before a server restart or stop, listing the agents it would end: proceed only
 * on confirm (warn, don't refuse).
 */
export function serverStopQuestion(
  host: string,
  action: 'restart' | 'stop',
  running: RemoteRunningAgents
): string {
  const verb = action === 'restart' ? 'Restart' : 'Stop'
  const head =
    action === 'restart'
      ? `Upgrade the server on ${host}? It restarts to take over.`
      : `Stop the Styr server on ${host}? Auto-run stops with it until you connect again.`
  if (!running.known) {
    const why = running.incompatible
      ? `${host} runs an incompatible server`
      : `${host} is not connected`
    return `${head}\n\n${why}, so Styr cannot tell which agents are running. Any that are stop too.`
  }
  if (running.agents.length === 0) return `${head}\n\nNo agents are running there.`
  const list = running.agents
    .map((agent) => `• ${agent.title}${agent.workspace ? ` (${agent.workspace})` : ''}`)
    .join('\n')
  return (
    `${head}\n\n${verb === 'Restart' ? 'Restarting' : 'Stopping'} it ends ${running.agents.length === 1 ? 'this agent' : `these ${running.agents.length} agents`}:\n${list}\n\n` +
    'Their cards show them stopped; resume each from its card.'
  )
}

/** Seconds until the next attempt, for "retrying in 8s", or undefined when none is planned. */
export function retryIn(host: RemoteHostState | undefined, now: number): number | undefined {
  if (host?.status !== 'reconnecting' || host.retryAt === undefined) return undefined
  return Math.max(0, Math.ceil((host.retryAt - now) / 1000))
}

/**
 * A workspace row's remote note in the switcher and in Settings → Workspaces: off, offline,
 * reconnecting or simply where it lives. Undefined for a local workspace.
 */
export function remoteNote(state: RemoteState, workspace: WorkspaceInfo): string | undefined {
  if (!workspace.remote) return undefined
  if (!state.enabled) return 'Remote workspaces are off'
  const host = state.hosts.find((entry) => entry.host === workspace.remote!.host)
  if (!host || host.status === 'offline') return `${workspace.remote.host} · offline`
  if (host.status === 'reconnecting') return `${workspace.remote.host} · reconnecting…`
  if (host.status === 'connecting') return `${workspace.remote.host} · connecting…`
  return workspace.remote.host
}

/** Whether a remote session's host is down, so its tab shows the disconnected overlay. */
export function sessionDisconnected(state: RemoteState, session: TerminalSessionInfo): boolean {
  if (!session.host) return false
  return state.hosts.find((entry) => entry.host === session.host)?.status !== 'connected'
}

/**
 * How "Open file" behaves for the open board: locally as always; for a remote file, in VS Code or
 * Cursor over ssh, or not at all (the tooltip then names the remote path). Copy path always works.
 */
export function remoteFileAction(
  access: BoardAccess,
  openFilesWith: string,
  path: string
): { open: boolean; reveal: boolean; openTitle: string; revealTitle: string } {
  if (!access.remote) {
    return {
      open: true,
      reveal: true,
      openTitle: path,
      revealTitle: 'Show the task file in its folder'
    }
  }
  const editor = remoteEditorFor(openFilesWith)
  const where = `On ${access.remote.host}: ${path}`
  return {
    open: editor !== undefined,
    reveal: false,
    openTitle: editor
      ? `Open in ${editor === 'cursor' ? 'Cursor' : 'VS Code'} over ssh — ${where}`
      : `${where}. Only VS Code or Cursor (Settings → Folders & terminal → Open files with) can open a remote file.`,
    revealTitle: `${where}. A remote file cannot be shown in this computer's file manager.`
  }
}

/** Where a Browse button looks: see `browseTarget`. */
export type BrowseTarget =
  { kind: 'native' } | { kind: 'remote'; host: string } | { kind: 'elsewhere'; reason: string }

/**
 * Where Browse looks, so it picks a path on the machine the workspace lives on: this computer's
 * own dialog for a local workspace, the in-app picker over the host's folders
 * (`terminal:listDirectories`, routed to the server) for a remote one. That listing follows the
 * open workspace, so Settings editing a remote workspace that is not the open one (`notOpen`)
 * cannot list its host, and says to open it.
 */
export function browseTarget(access: BoardAccess, notOpen = false): BrowseTarget {
  if (!access.remote) return { kind: 'native' }
  if (notOpen) {
    return {
      kind: 'elsewhere',
      reason: `This path is on ${access.remote.host}. Open the workspace to browse it there, or type it.`
    }
  }
  return { kind: 'remote', host: access.remote.host }
}

/** The open board's access and the remote state, for components deep in the tree. */
export const RemoteContext = createContext<{
  state: RemoteState
  access: BoardAccess
  /** Settings is editing a workspace other than the open one, whose calls the router follows. */
  notOpen?: boolean
}>({
  state: NO_REMOTE,
  access: { readOnly: false }
})

export function useBoardAccess(): BoardAccess {
  return useContext(RemoteContext).access
}

/** Where a Browse button in this part of the tree looks (`browseTarget`). */
export function useBrowseTarget(): BrowseTarget {
  const { access, notOpen } = useContext(RemoteContext)
  return browseTarget(access, notOpen)
}

export function useRemoteState(): RemoteState {
  return useContext(RemoteContext).state
}
