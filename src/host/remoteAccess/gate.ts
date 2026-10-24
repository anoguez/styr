import { isDeepStrictEqual } from 'node:util'
import { RPC_ERRORS, RpcError } from '@host/rpc/jsonRpc.js'

/**
 * What a network client may see and call. The host has one active workspace shared by every
 * client (`docs/architecture/remote.md`), so the gate is about whether that workspace — and any
 * other the client names — is shared with network clients (the `remoteAccess` setting). The
 * desktop's own window and `styr serve`'s Unix socket never have a policy and are never filtered.
 */

export interface ClientPolicy {
  /** Throws a `FORBIDDEN` RpcError when the client may not make this call. */
  check(method: string, params: unknown[]): void
  /** The answer the client may see. */
  result(method: string, params: unknown[], result: unknown): unknown
  /** The broadcast as this client may see it, or null to drop it. */
  broadcast(channel: string, payload: unknown): { payload: unknown } | null
  /** Whether the client may attach to, and hear from, this terminal. */
  terminal(id: string): boolean
}

export interface GatePorts {
  /** Shared with network clients: flagged, and not an ssh remote workspace's stub. */
  isOpen(workspaceId: string): boolean
  activeId(): string
  /** A terminal's workspace: `exists: false` when there is no such session. */
  sessionWorkspace(terminalId: string): { exists: boolean; workspaceId?: string }
  /** The app-level part of the settings as they are now, for `settings:save`. */
  currentGlobal(): unknown
}

const forbidden = (message: string): RpcError => new RpcError(RPC_ERRORS.FORBIDDEN, message)

/**
 * Calls that work whatever the active workspace is. Each checks the workspace it names, if any,
 * in `check`; the rest need the active workspace to be shared.
 */
const WITHOUT_ACTIVE = new Set([
  'server:info',
  'server:tray',
  'terminal:detach',
  'workspaces:list',
  'workspaces:activity',
  'workspaces:boardSummary',
  'workspaces:switch',
  'workspaces:rename',
  'workspaces:delete',
  'settings:get',
  'settings:save'
])

const DESKTOP_CALLS =
  /^(remote|updates|access|app:(?!mcpCommand)|terminal:native|settings:pick|settings:listApps)/

/** Never for a network client: they change what this computer does for every client. */
const NEVER = new Map<string, string>([
  ['server:experimental', 'Experimental switches belong to the desktop app.'],
  ['workspaces:create', 'A new workspace is created on the desktop.']
])

/** Channels whose first argument is a terminal id. */
const SESSION_FIRST = new Set([
  'terminal:attach',
  'terminal:detach',
  'terminal:focus',
  'terminal:resize',
  'terminal:write',
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

/** Broadcasts that describe the board and so need the active workspace shared. */
const SESSION_BROADCASTS = new Set(['terminal:runtimeState', 'terminal:exit'])
/** Events of the desktop window itself: the tray's command, the updater, ssh hosts, native frames. */
const DESKTOP_BROADCASTS = /^(remote|updates|access|app|terminal:native):?/
const ALWAYS_BROADCAST = new Set(['workspaces:changed', 'workspaces:activity', 'settings:changed'])

export function createNetworkPolicy(ports: GatePorts): ClientPolicy {
  const activeOpen = (): boolean => ports.isOpen(ports.activeId())

  function requireWorkspace(id: unknown): void {
    if (typeof id !== 'string' || !ports.isOpen(id)) {
      throw forbidden('This workspace is not shared with remote devices.')
    }
  }

  function requireSession(id: unknown): void {
    if (typeof id !== 'string' || !sessionOpen(id)) {
      throw forbidden('This terminal is not in a workspace shared with remote devices.')
    }
  }

  /** A session is open when its workspace is shared; a plain shell follows the active one. */
  function sessionOpen(id: string): boolean {
    const session = ports.sessionWorkspace(id)
    if (!session.exists) return false
    return session.workspaceId ? ports.isOpen(session.workspaceId) : activeOpen()
  }

  function keepOpen<T extends { id: string }>(workspaces: T[]): T[] {
    return workspaces.filter((workspace) => ports.isOpen(workspace.id))
  }

  /** `activeId` names a workspace the client may not know about: it is left empty. */
  const visibleActive = (): string => (activeOpen() ? ports.activeId() : '')

  return {
    check(method, params) {
      const never = NEVER.get(method)
      if (never) throw forbidden(never)
      if (DESKTOP_CALLS.test(method)) {
        throw forbidden('Not available to remote devices.')
      }

      switch (method) {
        case 'workspaces:switch':
        case 'workspaces:rename':
        case 'workspaces:delete':
          requireWorkspace(params[0])
          return
        case 'settings:get':
          if (params[0] !== undefined) requireWorkspace(params[0])
          else if (!activeOpen())
            throw forbidden('This workspace is not shared with remote devices.')
          return
        case 'settings:save': {
          const change = params[0] as { workspaceId?: unknown; global?: unknown } | undefined
          requireWorkspace(change?.workspaceId)
          // The app-level keys (storage folder, shortcuts, updates …) are the desktop's.
          if (!isDeepStrictEqual(change?.global, ports.currentGlobal())) {
            throw forbidden('App-level settings can only be changed on the desktop.')
          }
          return
        }
        case 'terminal:create': {
          const workspaceId = (params[0] as { workspaceId?: unknown } | undefined)?.workspaceId
          if (typeof workspaceId === 'string') requireWorkspace(workspaceId)
          else if (!activeOpen())
            throw forbidden('This workspace is not shared with remote devices.')
          return
        }
      }

      if (SESSION_FIRST.has(method)) {
        // Detaching never reveals anything, and must work after a workspace stops being shared.
        if (method !== 'terminal:detach') requireSession(params[0])
        return
      }
      if (!WITHOUT_ACTIVE.has(method) && !activeOpen()) {
        throw forbidden('This workspace is not shared with remote devices.')
      }
    },

    result(method, _params, result) {
      switch (method) {
        case 'workspaces:list':
        case 'workspaces:switch':
        case 'workspaces:rename':
        case 'workspaces:delete': {
          const overview = result as { activeId: string; workspaces: { id: string }[] }
          return {
            ...overview,
            activeId: visibleActive(),
            workspaces: keepOpen(overview.workspaces)
          }
        }
        case 'workspaces:activity':
          return filterActivity(result, ports, visibleActive())
        case 'workspaces:boardSummary':
          return Object.fromEntries(
            Object.entries(result as Record<string, unknown>).filter(([id]) => ports.isOpen(id))
          )
        case 'terminal:list':
          return (result as { id: string }[]).filter((session) => sessionOpen(session.id))
        case 'server:tray':
          return filterTray(result, ports)
      }
      return result
    },

    broadcast(channel, payload) {
      if (channel === 'server:notify' || DESKTOP_BROADCASTS.test(channel)) return null
      if (channel === 'server:tray') return { payload: filterTray(payload, ports) }
      if (channel === 'workspaces:activity') {
        return { payload: filterActivity(payload, ports, visibleActive()) }
      }
      if (channel === 'workspaces:changed') {
        const overview = payload as { activeId: string; workspaces: { id: string }[] } | undefined
        if (!overview || !Array.isArray(overview.workspaces)) return { payload }
        return {
          payload: {
            ...overview,
            activeId: visibleActive(),
            workspaces: keepOpen(overview.workspaces)
          }
        }
      }
      if (channel === 'settings:changed') {
        // Always delivered: it is how a client learns its workspace stopped being shared. Then it
        // is told only that, not the settings of a workspace it may no longer see.
        return { payload: activeOpen() ? payload : { remoteAccess: false } }
      }
      if (SESSION_BROADCASTS.has(channel)) {
        const id = (payload as { id?: unknown } | undefined)?.id
        return typeof id === 'string' && sessionOpen(id) ? { payload } : null
      }
      if (ALWAYS_BROADCAST.has(channel)) return { payload }
      return activeOpen() ? { payload } : null
    },

    terminal: sessionOpen
  }
}

function filterTray(value: unknown, ports: GatePorts): unknown {
  const tray = value as
    { statuses?: { workspaceId?: string }[]; titles?: Record<string, string> } | undefined
  if (!tray || !Array.isArray(tray.statuses)) return { statuses: [], titles: {} }
  const statuses = tray.statuses.filter((status) =>
    ports.isOpen(status.workspaceId ?? ports.activeId())
  )
  const keep = new Set(
    statuses.map((status) => {
      const s = status as { taskId?: string; workspaceId?: string }
      return s.workspaceId ? `${s.workspaceId}:${s.taskId}` : s.taskId
    })
  )
  const titles = Object.fromEntries(
    Object.entries(tray.titles ?? {}).filter(([key]) => keep.has(key))
  )
  return { statuses, titles }
}

function filterActivity(value: unknown, ports: GatePorts, activeId: string): unknown {
  const activity = value as { activeId?: string; byWorkspace?: Record<string, unknown> } | undefined
  if (!activity || typeof activity.byWorkspace !== 'object' || activity.byWorkspace === null) {
    return { activeId, byWorkspace: {} }
  }
  return {
    ...activity,
    activeId,
    byWorkspace: Object.fromEntries(
      Object.entries(activity.byWorkspace).filter(([id]) => ports.isOpen(id))
    )
  }
}
