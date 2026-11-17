import type { ShortcutCommand } from '@core/types.js'
import { isTerminalCommand, type TerminalCommand } from './terminalCommands.js'

/**
 * The terminal a detached window shows, from its `#detached=<id>` (`src/main/detachedTerminals.ts`),
 * or null for the main window.
 */
export function detachedSessionId(hash: string): string | null {
  const match = /^#?detached=(.+)$/.exec(hash)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]!) || null
  } catch {
    return null
  }
}

/** What a key does in a detached window, which has one terminal and no board. */
export type DetachedAction = 'dock' | 'close' | { terminal: TerminalCommand } | null

/**
 * The board's commands have no board to act on here: only the ones about this terminal answer.
 * `terminalDetach` toggles, so in a detached window it docks.
 */
export function detachedAction(command: ShortcutCommand | null): DetachedAction {
  if (!command) return null
  if (command === 'terminalDetach') return 'dock'
  if (command === 'closeShell') return 'close'
  return isTerminalCommand(command) ? { terminal: command } : null
}
