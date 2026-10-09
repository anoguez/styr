import { useEffect, useMemo, useState } from 'react'
import type { WorkspaceOverview, WorkspacesActivity } from '@core/types.js'

const EMPTY: WorkspaceOverview = { activeId: 'default', workspaces: [] }
const NO_ACTIVITY: WorkspacesActivity = { activeId: 'default', byWorkspace: {} }

export interface Workspaces {
  overview: WorkspaceOverview
  names: ReadonlyMap<string, string>
  /** Every workspace's live agent rollup, pushed by the main process on each agent event. */
  activity: WorkspacesActivity
  apply: (next: WorkspaceOverview) => void
}

/**
 * The workspaces and which one the board shows, kept current as they are created or removed.
 * Called once, in `App`; everything else is handed its result, so opening a dialog makes no call
 * of its own and has the list on its first render.
 */
export function useWorkspaces(): Workspaces {
  const [overview, setOverview] = useState<WorkspaceOverview>(EMPTY)
  const [activity, setActivity] = useState<WorkspacesActivity>(NO_ACTIVITY)

  useEffect(() => {
    const load = (): void => void window.api.workspaces.list().then(setOverview)
    load()
    return window.api.workspaces.onChanged(load)
  }, [])

  useEffect(() => {
    let pushed = false
    const unsubscribe = window.api.workspaces.onActivity((next) => {
      pushed = true
      setActivity(next)
    })
    void window.api.workspaces.activity().then((first) => {
      if (!pushed) setActivity(first)
    })
    return unsubscribe
  }, [])

  const names = useMemo(
    () => new Map(overview.workspaces.map((workspace) => [workspace.id, workspace.name])),
    [overview]
  )
  return { overview, names, activity, apply: setOverview }
}
