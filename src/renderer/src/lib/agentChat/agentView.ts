import type { AgentTabView } from '@core/types.js'

/**
 * Each agent tab's Chat switch, remembered by its session id: the surface can remount (the panel
 * closes, the workspace changes) without the tab forgetting it. Kept in memory, and in
 * `localStorage` so a reload of the window keeps it too; a storage that throws (blocked, full) only
 * costs the reload. A tab never switched follows Settings' default (`agentTabView`).
 */

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
  sessionId: string,
  fallback: AgentTabView,
  store: ViewStorage | null = storage()
): AgentTabView {
  const known = chosen.get(sessionId)
  if (known) return known
  let stored: AgentTabView | null
  try {
    stored = parse(store?.getItem(PREFIX + sessionId) ?? null)
  } catch {
    stored = null
  }
  if (stored) chosen.set(sessionId, stored)
  return stored ?? fallback
}

/** Remembers the view a tab was switched to. */
export function rememberAgentView(
  sessionId: string,
  view: AgentTabView,
  store: ViewStorage | null = storage()
): void {
  chosen.set(sessionId, view)
  try {
    store?.setItem(PREFIX + sessionId, view)
  } catch {
    // Remembered for this window only.
  }
}

/** For tests: forgets every tab's choice in memory. */
export function forgetAgentViews(): void {
  chosen.clear()
}
