import type { ShortcutBindings, ShortcutCommand } from './types.js'
import { SHORTCUT_COMMANDS } from './types.js'

/**
 * The parts of a key event this module reads. Spelled out rather than picked from the DOM's
 * `KeyboardEvent`, because core is compiled without the DOM lib so the MCP server can import it.
 */
export interface ShortcutKeyEvent {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

const MODIFIER_KEYS = new Set(['Shift', 'Alt', 'Control', 'Meta'])

/**
 * Sequences the terminal needs, which therefore cannot be bound to an app command. A user who
 * bound Ctrl+C here would break the only way to interrupt whatever is running in the panel, from
 * inside the panel, with no way back.
 */
const RESERVED = new Set(['ctrl+c', 'ctrl+d', 'ctrl+l', 'ctrl+z', 'escape', 'enter', 'tab'])

export const SHORTCUT_LABELS: Record<ShortcutCommand, string> = {
  newTask: 'New task',
  commandPalette: 'Command palette',
  focusSearch: 'Focus search',
  settings: 'Open Settings',
  toggleTerminal: 'Toggle the terminal panel',
  toggleAgents: 'Toggle the agents sidebar',
  orchestrate: 'Orchestrate',
  newShell: 'New terminal tab',
  closeShell: 'Close terminal tab',
  switchWorkspace: 'Switch workspace',
  newWorkspace: 'New workspace'
}

/**
 * Where a command's key binding applies. `terminal` commands answer only while an embedded terminal
 * has focus, so ⌘T opens a tab when you are typing in one and stays free everywhere else. Scope
 * only gates the key: the command palette runs every command from anywhere.
 */
export type ShortcutScope = 'window' | 'terminal'

export const SHORTCUT_SCOPES: Record<ShortcutCommand, ShortcutScope> = {
  newTask: 'window',
  commandPalette: 'window',
  focusSearch: 'window',
  settings: 'window',
  toggleTerminal: 'window',
  toggleAgents: 'window',
  orchestrate: 'window',
  newShell: 'terminal',
  closeShell: 'terminal',
  switchWorkspace: 'window',
  newWorkspace: 'window'
}

/** What a key event happened in. Required, so no caller can forget that scope exists. */
export interface ShortcutContext {
  terminalFocused: boolean
}

/**
 * The accelerator a key event represents, or null when the event is only modifiers. `mod` is the
 * platform's primary modifier — Command on macOS — so a stored binding reads the same everywhere.
 */
export function acceleratorFor(event: ShortcutKeyEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null
  const parts: string[] = []
  if (event.metaKey) parts.push('mod')
  if (event.ctrlKey) parts.push('ctrl')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')
  parts.push(event.key.toLowerCase())
  return parts.join('+')
}

export function matchesAccelerator(event: ShortcutKeyEvent, accelerator: string): boolean {
  return acceleratorFor(event) === accelerator
}

/**
 * The command a key event triggers, or null when nothing is bound to it here. A terminal-scoped
 * command is skipped outside the terminal, so its key falls through to whatever else holds it.
 */
export function commandForEvent(
  bindings: ShortcutBindings,
  event: ShortcutKeyEvent,
  context: ShortcutContext
): ShortcutCommand | null {
  const pressed = acceleratorFor(event)
  if (!pressed) return null
  for (const command of SHORTCUT_COMMANDS) {
    if (SHORTCUT_SCOPES[command] === 'terminal' && !context.terminalFocused) continue
    if (bindings[command].includes(pressed)) return command
  }
  return null
}

const SYMBOLS: Record<string, string> = {
  mod: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧'
}

const KEY_NAMES: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '↵',
  escape: 'Esc',
  ' ': 'Space'
}

/** An accelerator written the way macOS writes it, for display only. */
export function formatAccelerator(accelerator: string): string {
  const parts = accelerator.split('+')
  const key = parts.pop() ?? ''
  const modifiers = parts.map((part) => SYMBOLS[part] ?? part).join('')
  return modifiers + (KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key))
}

/** How a command's binding should be shown, empty when the user has unbound it. */
export function shortcutHint(bindings: ShortcutBindings, command: ShortcutCommand): string {
  const first = bindings[command][0]
  return first ? formatAccelerator(first) : ''
}

export function isReserved(accelerator: string): boolean {
  return RESERVED.has(accelerator)
}

/**
 * Which commands share an accelerator. Rebinding is allowed to produce a clash — refusing it would
 * force the user to unbind one command before giving its key to another — so the dialog warns
 * instead, and `commandForEvent` resolves a clash by declaration order.
 */
export function shortcutConflicts(bindings: ShortcutBindings): Map<string, ShortcutCommand[]> {
  const byAccelerator = new Map<string, ShortcutCommand[]>()
  for (const command of SHORTCUT_COMMANDS) {
    for (const accelerator of bindings[command]) {
      const existing = byAccelerator.get(accelerator)
      if (existing) existing.push(command)
      else byAccelerator.set(accelerator, [command])
    }
  }
  for (const [accelerator, commands] of byAccelerator) {
    if (commands.length < 2) byAccelerator.delete(accelerator)
  }
  return byAccelerator
}
