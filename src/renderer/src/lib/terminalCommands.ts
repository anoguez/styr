import type { ShortcutCommand } from '@core/types.js'

/** The shortcut commands that act on the focused terminal rather than on the app. */
export const TERMINAL_COMMANDS = [
  'terminalDirectory',
  'terminalAskAgent',
  'terminalCopyOutput',
  'terminalRetry',
  'terminalSplit'
] as const satisfies readonly ShortcutCommand[]

export type TerminalCommand = (typeof TERMINAL_COMMANDS)[number]

export function isTerminalCommand(command: ShortcutCommand): command is TerminalCommand {
  return (TERMINAL_COMMANDS as readonly string[]).includes(command)
}

const EVENT = 'styr:terminal-command'

/**
 * `App` owns the keydown chain, the active terminal owns the state a command acts on (its runtime,
 * its xterm buffer). A window event joins them without threading a ref through the panel; only the
 * active surface listens, so exactly one terminal answers.
 */
export function dispatchTerminalCommand(command: TerminalCommand): void {
  window.dispatchEvent(new CustomEvent<TerminalCommand>(EVENT, { detail: command }))
}

export function onTerminalCommand(handler: (command: TerminalCommand) => void): () => void {
  const listener = (event: Event): void => handler((event as CustomEvent<TerminalCommand>).detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
