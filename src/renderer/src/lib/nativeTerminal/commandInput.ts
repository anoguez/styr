import { pasteSequence, type KeyInput } from './keys.js'

/**
 * The block terminal's command input: an editor Styr owns, as in Warp, rather than the shell's
 * line editor. The shell sees a finished line only when it is submitted. Pure, so the key rules
 * are tested without a DOM.
 */

export type InputAction =
  | { kind: 'submit' }
  /** Ctrl+C: drop what is typed (nothing is running to interrupt). */
  | { kind: 'discard' }
  /** Ctrl+L: empty the block list. */
  | { kind: 'clearBlocks' }
  | { kind: 'history'; step: -1 | 1 }
  /** Tab: kept in the input (completions are the shell's, which it does not see yet). */
  | { kind: 'swallow' }
  /** Let the textarea do what it does (type, move, select, newline on Shift+Enter). */
  | { kind: 'default' }

export interface Caret {
  text: string
  start: number
  end: number
}

export function inputAction(key: KeyInput & { isComposing?: boolean }, caret: Caret): InputAction {
  if (key.isComposing) return { kind: 'default' }
  const plain = !key.ctrlKey && !key.altKey && !key.metaKey
  if (key.key === 'Enter' && plain && !key.shiftKey) return { kind: 'submit' }
  if (key.ctrlKey && !key.metaKey && !key.altKey && !key.shiftKey) {
    if (key.key === 'c') return { kind: 'discard' }
    if (key.key === 'l') return { kind: 'clearBlocks' }
  }
  if (key.key === 'Tab' && plain) return { kind: 'swallow' }
  const collapsed = caret.start === caret.end
  if (plain && !key.shiftKey && collapsed) {
    // Up on the first line and Down on the last step through history; elsewhere they move.
    if (key.key === 'ArrowUp' && !caret.text.slice(0, caret.start).includes('\n')) {
      return { kind: 'history', step: -1 }
    }
    if (key.key === 'ArrowDown' && !caret.text.slice(caret.end).includes('\n')) {
      return { kind: 'history', step: 1 }
    }
  }
  return { kind: 'default' }
}

/**
 * What the PTY gets for a submitted command: the line and Enter. Several lines go as one
 * bracketed paste when the shell accepts it, so the shell runs them as one command rather than
 * line by line.
 */
export function submission(text: string, bracketed: boolean): string {
  if (!text.includes('\n')) return `${text}\r`
  return `${pasteSequence(text, bracketed)}\r`
}

/** How long after a prompt's paste its Enter is sent; see `agentPrompt`. */
export const AGENT_ENTER_DELAY_MS = 120

/**
 * What an agent CLI's TUI gets for a submitted prompt: the text as one bracketed paste, then Enter
 * as a keystroke of its own, `AGENT_ENTER_DELAY_MS` later. An agent's input box takes a burst of
 * input that arrives at once as a paste, so an Enter written with the text is a newline in the
 * box, not a submit; on its own it is the key the person would press.
 */
export function agentPrompt(text: string): { paste: string; enter: string } {
  return { paste: pasteSequence(text, true), enter: '\r' }
}

/**
 * Steps through `history` (oldest first). `index` is null while editing a new command, whose text
 * is kept in `draft` and comes back after the newest entry.
 */
export interface HistoryCursor {
  index: number | null
  draft: string
}

export function stepHistory(
  history: string[],
  cursor: HistoryCursor,
  text: string,
  step: -1 | 1
): { cursor: HistoryCursor; text: string } | null {
  if (history.length === 0) return null
  if (cursor.index === null) {
    if (step === 1) return null
    const index = history.length - 1
    return { cursor: { index, draft: text }, text: history[index]! }
  }
  const index = cursor.index + step
  if (index < 0) return null
  if (index >= history.length) {
    return { cursor: { index: null, draft: '' }, text: cursor.draft }
  }
  return { cursor: { index, draft: cursor.draft }, text: history[index]! }
}
