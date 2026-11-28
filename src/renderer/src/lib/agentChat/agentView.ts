import type { AgentTabView } from '@core/types.js'

/**
 * Each agent tab's Chat switch, remembered by its session id: the surface can remount (the panel
 * closes, the workspace changes) without the tab forgetting it. Kept in memory, and in
 * `localStorage` so a reload of the window keeps it too; a storage that throws (blocked, full) only
 * costs the reload. A tab never switched follows Settings' default (`agentTabView`).
 */

/**
 * Each agent tab's Chat switch, remembered by the task the agent works on (`agentViewKey`): a
 * relaunch of Styr restores the tab under a new session id, and a task's agent can be started
 * again, and the tab should open as it was left either way. A tab without a task is remembered by
 * its session id. Kept in memory, and in `localStorage` so a reload or a relaunch keeps it; a
 * storage that throws (blocked, full) only costs that. A tab never switched follows Settings'
 * default (`agentTabView`).
 */

/** What a tab's choice is kept under: its workspace and task, or its session when it has none. */
export function agentViewKey(session: {
  id: string
  taskId?: string
  workspaceId?: string
}): string {
  return session.taskId ? `task:${session.workspaceId ?? ''}:${session.taskId}` : session.id
}

/** The part of `Storage` this reads, so a test can pass a map. */
export interface ViewStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const PREFIX = 'styr.agentView.'
const chosen = new Map<string, AgentTabView>()

function storage(): ViewStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function parse(value: string | null): AgentTabView | null {
  return value === 'chat' || value === 'terminal' ? value : null
}

/** The view this tab was last switched to, or `fallback` (the Settings default) if never. */
export function agentViewFor(
  key: string,
  fallback: AgentTabView,
  store: ViewStorage | null = storage()
): AgentTabView {
  const known = chosen.get(key)
  if (known) return known
  let stored: AgentTabView | null
  try {
    stored = parse(store?.getItem(PREFIX + key) ?? null)
  } catch {
    stored = null
  }
  if (stored) chosen.set(key, stored)
  return stored ?? fallback
}

/** Remembers the view a tab was switched to. */
export function rememberAgentView(
  key: string,
  view: AgentTabView,
  store: ViewStorage | null = storage()
): void {
  chosen.set(key, view)
  try {
    store?.setItem(PREFIX + key, view)
  } catch {
    // Remembered for this window only.
  }
}

/** For tests: forgets every tab's choice in memory. */
export function forgetAgentViews(): void {
  chosen.clear()
}
