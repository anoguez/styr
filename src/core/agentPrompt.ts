/**
 * How a prompt reaches an agent CLI running in a terminal, shared by Styr Terminal's input and
 * the host (Request changes in the Changes dialog). Pure, so the renderer imports it too.
 */

/** Longest prompt sent through an agent's inbox, or as one review message. */
export const MAX_PROMPT_CHARS = 100_000

/** Bracketed paste wraps pasted text so a shell or editor does not run it line by line. */
export function pasteSequence(text: string, bracketed: boolean): string {
  // A newline is sent as CR, as typed; and a pasted end marker must not end the paste early.
  const normalised = text.replace(/\r?\n/g, '\r')
  if (!bracketed) return normalised
  return `\x1b[200~${normalised.replaceAll('\x1b[201~', '')}\x1b[201~`
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
 * How a prompt reaches the agent: through its inbox (`promptInbox`), as the person's own words, or
 * typed into its TUI. Typed when there is no inbox; for a command, which may open the CLI's own
 * picker; and for one line that mentions a file (`@path`), which only the TUI expands — a prompt
 * submitted on the person's behalf is taken literally.
 */
export function promptRoute(text: string, inbox: boolean): 'inbox' | 'keys' {
  if (!inbox || /^\/[\w:.-]+(\s|$)/.test(text.trim())) return 'keys'
  if (!text.includes('\n') && /(^|\s)@\S/.test(text)) return 'keys'
  return 'inbox'
}
