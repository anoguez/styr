import type { WorkspaceBoardSummary, WorkspaceOverview } from '@core/types.js'
import type { HostEntry, RemoteRegistry, RemoteTarget } from './registry.js'

/**
 * The servers' workspaces as the client sees them: which one each server shows, switching it, and
 * the stubs' counts and summaries taken from their servers. `styr serve` has one active workspace
 * shared by every client, so it follows the most recent client to switch (TASK-0131).
 */

export interface RemoteWorkspacesEvents {
  /** Something the renderer's remote state shows changed. */
  stateChanged(): void
  /** A switch this client asked for finished (or failed): the board can be fetched. */
  switched(entry: HostEntry): void
}

export function createRemoteWorkspaces(registry: RemoteRegistry, events: RemoteWorkspacesEvents) {
  function setOverview(entry: HostEntry, overview: WorkspaceOverview): void {
    entry.overview = overview
    entry.serverActiveId = overview.activeId
    entry.overviewStale = false
  }

  /**
   * Points the server at this workspace. Until connected the switch waits (`wantSwitch`), and
   * `onConnected` makes it; calls for the board wait for a switch on its way.
   */
  function requestSwitch(target: RemoteTarget): void {
    const entry = target.host
    const remoteId = target.link.workspaceId
    entry.wantSwitch = remoteId
    if (!entry.conn.connected) return events.stateChanged()
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
        events.stateChanged()
        events.switched(entry)
      })
    entry.switching = switching
    events.stateChanged()
  }

  return {
    setOverview,
    requestSwitch,

    async fetchOverview(entry: HostEntry): Promise<void> {
      try {
        setOverview(entry, (await entry.conn.request('workspaces:list')) as WorkspaceOverview)
      } catch {
        entry.overviewStale = false
      }
    },

    /** Stubs take their task and session counts from the server's list when it is known. */
    mergeOverview(overview: WorkspaceOverview): WorkspaceOverview {
      return {
        ...overview,
        workspaces: overview.workspaces.map((workspace) => {
          const link = registry.links.get(workspace.id)?.remote
          if (!link) return workspace
          const remote = registry.hosts
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
    },

    /** The switcher's Inbox counts: the stubs' from their servers, never the empty local folders. */
    async mergeSummaries(
      local: Record<string, WorkspaceBoardSummary>
    ): Promise<Record<string, WorkspaceBoardSummary>> {
      const merged = { ...local }
      for (const id of registry.links.keys()) delete merged[id]
      if (!registry.enabled) return merged
      await Promise.all(
        [...registry.hosts.values()].map(async (entry) => {
          if (!entry.conn.connected) return
          try {
            const remote = (await entry.conn.request('workspaces:boardSummary')) as Record<
              string,
              WorkspaceBoardSummary
            >
            for (const [serverId, summary] of Object.entries(remote)) {
              const stub = registry.stubFor(entry.host, serverId)
              if (stub) merged[stub.id] = summary
            }
          } catch {
            // The menu shows the agent state alone.
          }
        })
      )
      return merged
    }
  }
}

export type RemoteWorkspaces = ReturnType<typeof createRemoteWorkspaces>
