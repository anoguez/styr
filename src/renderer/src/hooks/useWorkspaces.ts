import { useEffect, useMemo, useState } from 'react'
import type { WorkspaceOverview } from '@core/types.js'

const EMPTY: WorkspaceOverview = { activeId: 'default', workspaces: [] }

/** The workspaces and which one the board shows, kept current as they are created or removed. */
export function useWorkspaces(): {
  overview: WorkspaceOverview
  names: ReadonlyMap<string, string>
  apply: (next: WorkspaceOverview) => void
} {
  const [overview, setOverview] = useState<WorkspaceOverview>(EMPTY)

  useEffect(() => {
    const load = (): void => void window.api.workspaces.list().then(setOverview)
    load()
    return window.api.workspaces.onChanged(load)
  }, [])

  const names = useMemo(
    () => new Map(overview.workspaces.map((workspace) => [workspace.id, workspace.name])),
    [overview]
  )
  return { overview, names, apply: setOverview }
}
