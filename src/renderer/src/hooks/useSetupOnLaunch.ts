import { useEffect, useRef } from 'react'
import type { Settings, WorkspaceOverview } from '@core/types.js'
import type { AppShellAction } from '../lib/appShell.js'
import { markSetupSeen, setupSeen, shouldWelcome } from '../lib/setupWizard.js'

/**
 * Opens the welcome wizard once, for someone who has not set anything up yet (`shouldWelcome`).
 * Anyone else is marked as having seen it, so Quick setup in the palette is the only way back. It
 * waits for any other modal to close first.
 */
export function useSetupOnLaunch(
  settings: Settings | null,
  overview: WorkspaceOverview,
  modalOpen: boolean,
  dispatch: (action: AppShellAction) => void
): void {
  const decided = useRef(false)
  const loaded = settings !== null && overview.workspaces.length > 0
  const repo = settings?.defaultRepoPath ?? ''
  const taskCount = overview.workspaces.reduce((sum, workspace) => sum + workspace.taskCount, 0)

  useEffect(() => {
    if (!loaded || modalOpen || decided.current) return
    decided.current = true
    if (setupSeen()) return
    if (shouldWelcome({ seen: false, defaultRepoPath: repo, taskCount })) {
      dispatch({ type: 'setup', mode: 'first-run' })
    } else {
      markSetupSeen()
    }
  }, [loaded, modalOpen, repo, taskCount, dispatch])
}
