import { pasteSequence } from '@core/agentPrompt.js'
import type { AgentConversation, ApprovalOption } from '@core/agentConversation.js'
import { promptRoute } from '../nativeTerminal/commandInput.js'

/**
 * The pure half of an agent tab's chat, shared by both terminal engines: how the conversation is
 * watched, where a prompt goes, how an approval is answered and when a slash command's TUI hands
 * back. `useAgentChat` binds it to React and `window.api`; tests bind it to fakes.
 */

/** What the chat reads and sends through: `window.api.usage` and `window.api.terminal.write`. */
export interface AgentChatPort {
  conversation: (terminalId: string) => Promise<AgentConversation | null>
  onConversation: (
    handler: (update: { terminalId: string; conversation: AgentConversation }) => void
  ) => () => void
  sendPrompt: (terminalId: string, text: string) => Promise<boolean>
  approval: (terminalId: string, approvalId: string, optionId: string) => Promise<void>
  /** Types into the session's PTY. */
  write: (terminalId: string, data: string) => void
}

/** The browser's port: the preload's agent channels and the PTY. */
export function windowChatPort(): AgentChatPort {
  const { usage, terminal } = window.api
  return {
    conversation: usage.conversation,
    onConversation: usage.onConversation,
    sendPrompt: usage.sendPrompt,
    approval: usage.approval,
    write: terminal.write
  }
}

/**
 * Follows one terminal's conversation: what the host has now, then each push for this terminal.
 * A push that lands before the first read wins over it. Returns the unsubscribe.
 */
export function watchConversation(
  port: Pick<AgentChatPort, 'conversation' | 'onConversation'>,
  terminalId: string,
  set: (conversation: AgentConversation) => void
): () => void {
  let live = true
  let pushed = false
  void port.conversation(terminalId).then((value) => {
    if (live && value && !pushed) set(value)
  })
  const off = port.onConversation(({ terminalId: id, conversation }) => {
    if (!live || id !== terminalId) return
    pushed = true
    set(conversation)
  })
  return () => {
    live = false
    off()
  }
}

/**
 * Sends a prompt as the person typed it: through the agent's own inbox when it reads one (so it is
 * filed as their words), else by `type` into the CLI's TUI — also when the inbox refuses it, and
 * whenever an image waits in the TUI's input, since that image only goes with a typed prompt.
 */
export function sendChatPrompt({
  port,
  terminalId,
  text,
  conversation,
  attachedImages,
  type
}: {
  port: Pick<AgentChatPort, 'sendPrompt'>
  terminalId: string
  text: string
  conversation: AgentConversation | null
  attachedImages: number
  type: (text: string) => void
}): void {
  const inbox = conversation?.promptInbox === true && attachedImages === 0
  if (promptRoute(text, inbox) !== 'inbox') return type(text)
  void port.sendPrompt(terminalId, text).then(
    (sent) => {
      if (!sent) type(text)
    },
    () => type(text)
  )
}

/**
 * Answers what the agent waits on with one of its options: by id through its channel when the
 * conversation carries the request, else with the TUI dialog's keys (Enter allows once, Escape
 * refuses).
 */
export function answerApproval({
  port,
  terminalId,
  conversation,
  option
}: {
  port: Pick<AgentChatPort, 'approval' | 'write'>
  terminalId: string
  conversation: AgentConversation | null
  option: ApprovalOption
}): void {
  if (conversation?.approval) {
    // Already answered in the CLI's own view when this fails: nothing left to do.
    port.approval(terminalId, conversation.approval.id, option.id).catch(() => {})
    return
  }
  port.write(terminalId, option.kind === 'deny' ? '\x1b' : '\r')
}

/** Where the conversation stood when a slash command went to the CLI. */
export interface CommandSent {
  at: string
  messages: number
}

/**
 * A slash command may answer in the CLI's own interface (a picker, a dialog), which only the
 * terminal draws, so the chat steps aside after one. It comes back once the conversation moves on:
 * a turn starts or a message is added, in a write after the one the command was sent against.
 */
export function commandSettled(sent: CommandSent, conversation: AgentConversation | null): boolean {
  if (!conversation || conversation.at === sent.at) return false
  return conversation.working || conversation.messages.length !== sent.messages
}

/** An image dropped on the chat, waiting in the composer for the next prompt. */
export interface ChatImage {
  id: string
  name: string
  /** Its path, quoted for the tab's shell, as a terminal drop pastes it. */
  quoted: string
  /** A data URL to draw its card from (the CSP allows `data:`), once read. */
  preview?: string
}

/** Whether a dropped file is an image the chat shows as a card rather than as its path. */
export function isImageFile(file: Pick<File, 'type'>): boolean {
  return file.type.startsWith('image/')
}

/**
 * What the CLI's own input gets for the images going with a prompt: their paths as one bracketed
 * paste, as a drop on the terminal pastes them. Claude Code turns a pasted image path into an
 * attachment; the prompt is then typed after them, since the images only go with a typed prompt.
 */
export function imagesPaste(images: readonly Pick<ChatImage, 'quoted'>[]): string {
  return pasteSequence(images.map((image) => image.quoted).join(' ') + ' ', true)
}
