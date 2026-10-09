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
  quickTask: 'Quick add task',
  quickOpen: 'Go to task, agent or terminal',
  commandPalette: 'Command palette',
  focusSearch: 'Focus search',
  viewBoard: 'Show the board',
  viewInbox: 'Show the inbox',
  settings: 'Open Settings',
  toggleTerminal: 'Toggle the terminal panel',
  toggleAgents: 'Toggle the agents sidebar',
  orchestrate: 'Dispatch',
  toggleAutoDispatch: 'Toggle Dispatch auto-run',
  newShell: 'New terminal tab',
  closeShell: 'Close terminal tab',
  switchWorkspace: 'Switch workspace',
  newWorkspace: 'New workspace',
  terminalDirectory: 'Terminal: change directory',
  terminalAskAgent: 'Terminal: ask agent about this terminal',
  terminalCopyOutput: 'Terminal: copy all output',
  terminalRetry: 'Terminal: retry last command',
  terminalSplit: 'Terminal: split into a new tab here',
  terminalAskReview: 'Terminal: ask for a review of this task',
  terminalHandOff: 'Terminal: hand off to another agent',
  terminalCreatePr: 'Terminal: ask the agent to create a pull request',
  terminalTab1: 'Go to terminal tab 1',
  terminalTab2: 'Go to terminal tab 2',
  terminalTab3: 'Go to terminal tab 3',
  terminalTab4: 'Go to terminal tab 4',
  terminalTab5: 'Go to terminal tab 5',
  terminalTab6: 'Go to terminal tab 6',
  terminalTab7: 'Go to terminal tab 7',
  terminalTab8: 'Go to terminal tab 8',
  terminalTab9: 'Go to terminal tab 9'
}

/**
 * Where a command's key binding applies. `terminal` commands answer only while an embedded terminal
 * has focus, so ⌘T opens a tab when you are typing in one and stays free everywhere else. Scope
 * only gates the key: the command palette runs every command from anywhere.
 */
export type ShortcutScope = 'window' | 'terminal'

export const SHORTCUT_SCOPES: Record<ShortcutCommand, ShortcutScope> = {
  newTask: 'window',
  quickTask: 'window',
  quickOpen: 'window',
  commandPalette: 'window',
  focusSearch: 'window',
  viewBoard: 'window',
  viewInbox: 'window',
  settings: 'window',
  toggleTerminal: 'window',
  toggleAgents: 'window',
  orchestrate: 'window',
  toggleAutoDispatch: 'window',
  newShell: 'terminal',
  closeShell: 'terminal',
  switchWorkspace: 'window',
  newWorkspace: 'window',
  terminalDirectory: 'terminal',
  terminalAskAgent: 'terminal',
  terminalCopyOutput: 'terminal',
  terminalRetry: 'terminal',
  terminalSplit: 'terminal',
  terminalAskReview: 'terminal',
  terminalHandOff: 'terminal',
  terminalCreatePr: 'terminal',
  terminalTab1: 'window',
  terminalTab2: 'window',
  terminalTab3: 'window',
  terminalTab4: 'window',
  terminalTab5: 'window',
  terminalTab6: 'window',
  terminalTab7: 'window',
  terminalTab8: 'window',
  terminalTab9: 'window'
}

/**
 * The physical key `mod` stands for: Command on macOS, Control elsewhere. Stored bindings say `mod`
 * so they read the same on every platform. Defaults to macOS; the renderer sets it once at startup
 * (core has no DOM to ask, and the MCP server never reads keys).
 */
let primaryModifier: 'meta' | 'ctrl' = 'meta'

export function setPrimaryModifier(modifier: 'meta' | 'ctrl'): void {
  primaryModifier = modifier
}

export function usesControlAsPrimary(): boolean {
  return primaryModifier === 'ctrl'
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
  if (primaryModifier === 'meta') {
    if (event.metaKey) parts.push('mod')
    if (event.ctrlKey) parts.push('ctrl')
  } else {
    if (event.ctrlKey) parts.push('mod')
    if (event.metaKey) parts.push('meta')
  }
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
  const bound = (accelerator: string): ShortcutCommand | null => {
    for (const command of SHORTCUT_COMMANDS) {
      if (SHORTCUT_SCOPES[command] === 'terminal' && !context.terminalFocused) continue
      if (bindings[command].includes(accelerator)) return command
    }
    return null
  }
  if (primaryModifier === 'meta' || !context.terminalFocused) return bound(pressed)
  // Where `mod` is Control, Ctrl+letter in a terminal is a control character the shell needs
  // (Ctrl+R searches history, Ctrl+D ends input, Ctrl+W deletes a word), so it always reaches the
  // shell. As in Windows Terminal and VS Code, Ctrl+Shift+letter reaches the command instead, unless
  // something is bound to that combination itself.
  if (/^mod\+[a-z]$/.test(pressed)) return null
  const shifted = /^mod\+shift\+([a-z])$/.exec(pressed)
  return bound(pressed) ?? (shifted ? bound(`mod+${shifted[1]}`) : null)
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

const WORDS: Record<string, string> = {
  mod: 'Ctrl',
  ctrl: 'Ctrl',
  meta: 'Win',
  alt: 'Alt',
  shift: 'Shift'
}

const KEY_WORDS: Record<string, string> = {
  ...KEY_NAMES,
  enter: 'Enter'
}

/** An accelerator written the way the platform writes it (⇧⌘N on macOS, Ctrl+Shift+N elsewhere). */
export function formatAccelerator(accelerator: string): string {
  const parts = accelerator.split('+')
  const key = parts.pop() ?? ''
  if (primaryModifier === 'ctrl') {
    const name = KEY_WORDS[key] ?? (key.length === 1 ? key.toUpperCase() : key)
    return [...parts.map((part) => WORDS[part] ?? part), name].join('+')
  }
  const modifiers = parts.map((part) => SYMBOLS[part] ?? part).join('')
  return modifiers + (KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key))
}

/** How a command's binding should be shown, empty when the user has unbound it. */
export function shortcutHint(bindings: ShortcutBindings, command: ShortcutCommand): string {
  const first = bindings[command][0]
  return first ? formatAccelerator(first) : ''
}

export function isReserved(accelerator: string): boolean {
  // Where Control is `mod`, the terminal's Ctrl+C arrives as `mod+c`.
  const physical = primaryModifier === 'ctrl' ? accelerator.replace(/^mod\+/, 'ctrl+') : accelerator
  return RESERVED.has(physical)
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
