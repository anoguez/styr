import { agentKey, type AgentStatus } from '@core/agentState.js'
import type { WorkspacesActivity } from '@core/types.js'
import type { HostEntry, RemoteRegistry } from './registry.js'

/**
 * The tray and the workspace switcher's rollup, merged: this machine's agents with every connected
 * server's, re-tagged with the stubs' ids and names. The first tray model after a (re)connect is a
 * baseline, so agents that began waiting while disconnected are shown, not announced.
 */

export interface RollupPorts {
  broadcast(channel: string, payload?: unknown): void
  /** Main's `updateTray`; `quiet` keys must not raise "needs you". */
  updateTray(statuses: AgentStatus[], titles: Map<string, string>, quiet: ReadonlySet<string>): void
}

interface TrayModel {
  statuses: AgentStatus[]
  titles: Map<string, string>
}

export function createRollup(registry: RemoteRegistry, ports: RollupPorts) {
  let localActivity: WorkspacesActivity | undefined
  let localTray: TrayModel = { statuses: [], titles: new Map() }

  function mergedActivity(): WorkspacesActivity {
    const byWorkspace = { ...(localActivity?.byWorkspace ?? {}) }
    for (const id of registry.links.keys()) delete byWorkspace[id]
    if (registry.enabled) {
      for (const entry of registry.hosts.values()) Object.assign(byWorkspace, entry.activity ?? {})
    }
    return { activeId: localActivity?.activeId ?? registry.activeId(), byWorkspace }
  }

  function emitActivity(): void {
    if (!localActivity && registry.hosts.size === 0) return
    ports.broadcast('workspaces:activity', mergedActivity())
  }

  function emitTray(): void {
    const stubIds = registry.links
    const statuses = localTray.statuses.filter((s) => !s.workspaceId || !stubIds.has(s.workspaceId))
    const titles = new Map(localTray.titles)
    const quiet = new Set<string>()
    if (registry.enabled) {
      for (const entry of registry.hosts.values()) {
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

  return {
    mergedActivity,
    emitActivity,
    emitTray,

    /** Re-sends both, after the hosts or stubs changed. */
    emitAll(): void {
      emitTray()
      emitActivity()
    },

    /** The local agents service's rollup. With nothing remote it goes out unchanged. */
    localActivityChanged(activity: WorkspacesActivity): void {
      localActivity = activity
      if (!registry.any) return ports.broadcast('workspaces:activity', activity)
      emitActivity()
    },

    /** The local tray model, as the agents service built it. With nothing remote, unchanged. */
    localTrayChanged(statuses: AgentStatus[], titles: Map<string, string>): void {
      localTray = { statuses, titles }
      if (!registry.any) return ports.updateTray(statuses, titles, new Set())
      emitTray()
    },

    /** A server's rollup, keyed by the stubs that link to its workspaces. */
    setActivity(entry: HostEntry, activity: WorkspacesActivity | undefined): void {
      const byWorkspace: WorkspacesActivity['byWorkspace'] = {}
      for (const [serverId, value] of Object.entries(activity?.byWorkspace ?? {})) {
        const stub = registry.stubFor(entry.host, serverId)
        if (stub) byWorkspace[stub.id] = value
      }
      entry.activity = byWorkspace
      emitActivity()
    },

    /** A server's tray model, re-tagged with the stubs' ids and names; others are dropped. */
    setTray(entry: HostEntry, payload: unknown): void {
      const { statuses = [], titles = {} } = (payload ?? {}) as {
        statuses?: AgentStatus[]
        titles?: Record<string, string>
      }
      const mapped: AgentStatus[] = []
      const mappedTitles = new Map<string, string>()
      for (const status of statuses) {
        const stub = status.workspaceId
          ? registry.stubFor(entry.host, status.workspaceId)
          : undefined
        if (!stub) continue
        const local = { ...status, workspaceId: stub.id, workspaceName: stub.name }
        mapped.push(local)
        const title = titles[agentKey(status)]
        if (title) mappedTitles.set(agentKey(local), title)
      }
      entry.tray = { statuses: mapped, titles: mappedTitles }
      emitTray()
    },

    /** A host disconnected: its agents leave the tray and the rollup until it is back. */
    clearHost(entry: HostEntry): void {
      entry.activity = undefined
      entry.tray = undefined
      emitTray()
      emitActivity()
    }
  }
}

export type Rollup = ReturnType<typeof createRollup>
