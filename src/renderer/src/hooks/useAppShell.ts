import { useEffect, useReducer } from 'react'
import { appShellReducer, initialAppShell, type View } from '../lib/appShell.js'

const VIEW_KEY = 'styr:view'

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'inbox' ? 'inbox' : 'board'
  } catch {
    return 'board'
  }
}

/**
 * The shell state (`lib/appShell.ts`) with its two side effects: the view is remembered across
 * launches, and switching workspace closes an open task.
 */
export function useAppShell(workspaceId: string) {
  const [shell, dispatch] = useReducer(appShellReducer, undefined, () =>
    initialAppShell(savedView())
  )
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, shell.view)
    } catch {
      // Remembering the view is a convenience; a blocked store just means it resets.
    }
  }, [shell.view])
  useEffect(() => dispatch({ type: 'workspaceChanged' }), [workspaceId])
  return [shell, dispatch] as const
}
