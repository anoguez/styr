import type { ShortcutBindings } from '@core/types.js'
import { commandForEvent, type ShortcutKeyEvent } from '@core/shortcuts.js'

/**
 * Claude Code treats ESC + CR as "insert a newline" — it is what `/terminal-setup` binds
 * Shift+Enter to in iTerm2 and VS Code. A terminal sends a bare CR for both Enter and
 * Shift+Enter, so the embedded terminal has to emit the distinct sequence itself.
 */
const NEWLINE_SEQUENCE = '\x1b\r'

export type ModifierKeyEvent = ShortcutKeyEvent & Pick<KeyboardEvent, 'type'>

/**
 * The bytes to send for a multi-line newline, or null when the key should fall through to the
 * terminal unchanged.
 */
export function multilineSequence(event: ModifierKeyEvent): string | null {
  if (event.type !== 'keydown' || event.key !== 'Enter') return null
  if (event.ctrlKey || event.metaKey) return null
  return event.shiftKey || event.altKey ? NEWLINE_SEQUENCE : null
}

/**
 * Keys the app handles itself. The embedded terminal must not also forward them to the shell —
 * Ctrl+` in particular is a control sequence the shell would otherwise receive. Derived from the
 * user's bindings rather than a list of its own, so a rebind can never leave the two disagreeing.
 * Reserved sequences (Escape, Ctrl+C, Ctrl+L) cannot be bound, so they always reach the terminal.
 */
export function isAppShortcut(event: ModifierKeyEvent, bindings: ShortcutBindings): boolean {
  if (event.type !== 'keydown') return false
  return commandForEvent(bindings, event, { terminalFocused: true }) !== null
}

/**
 * Whether a key event came from the terminal panel: an embedded terminal (xterm types into a hidden
 * textarea inside its `.xterm` root), the tab strip, or the panel itself, which is focusable so its
 * empty state counts too — otherwise ⌘T could not open the first tab.
 */
export function isTerminalTarget(
  target: { closest?: (selector: string) => unknown } | null
): boolean {
  return (
    typeof target?.closest === 'function' &&
    target.closest('.xterm, [data-terminal-panel]') !== null
  )
}
