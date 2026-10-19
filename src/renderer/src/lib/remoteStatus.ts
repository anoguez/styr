import { createContext, useContext } from 'react'
import { remoteEditorFor } from '@core/remote.js'
import type {
  RemoteHostState,
  RemoteState,
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
      return `${host.host} offline`
    default:
      return 'Not connected'
  }
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
      : `${where}. Only VS Code or Cursor (Settings → General → Open files with) can open a remote file.`,
    revealTitle: `${where}. A remote file cannot be shown in this computer's file manager.`
  }
}

/**
 * Why a Browse button is off, or undefined when it works. The native pickers browse this computer,
 * and a path picked there means nothing on a remote host: the server would quietly start the agent
 * in its home folder instead. A remote path is typed.
 */
export function localPickerBlocked(access: BoardAccess): string | undefined {
  return access.remote
    ? `This path is on ${access.remote.host}; type it. Browse picks from this computer.`
    : undefined
}

/** The open board's access and the remote state, for components deep in the tree. */
export const RemoteContext = createContext<{ state: RemoteState; access: BoardAccess }>({
  state: NO_REMOTE,
  access: { readOnly: false }
})

export function useBoardAccess(): BoardAccess {
  return useContext(RemoteContext).access
}

export function useRemoteState(): RemoteState {
  return useContext(RemoteContext).state
}
