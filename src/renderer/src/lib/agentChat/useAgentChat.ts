import { useEffect, useMemo, useRef, useState } from 'react'
import {
  agentBlocks,
  promptHistory,
  type AgentConversation,
  type ApprovalOption
} from '@core/agentConversation.js'
import { conversationAdapter } from '@core/providers/conversation.js'
import type { AgentProviderId } from '@core/providers/types.js'
import { AGENT_ENTER_DELAY_MS, agentPrompt } from '../nativeTerminal/commandInput.js'
import { isSlashCommand } from '../nativeTerminal/commandMenu.js'
import { approvalRequest } from './agentApproval.js'
import {
  answerApproval,
  commandSettled,
  imagesPaste,
  type ChatImage,
  sendChatPrompt,
  watchConversation,
  windowChatPort,
  type AgentChatPort,
  type CommandSent
} from './agentChat.js'

/** The conversation of the agent CLI in a terminal, as its provider's source writes it. */
export function useAgentConversation(sessionId: string): AgentConversation | null {
  const [conversation, setConversation] = useState<AgentConversation | null>(null)
  useEffect(() => {
    setConversation(null)
    return watchConversation(windowChatPort(), sessionId, setConversation)
  }, [sessionId])
  return conversation
}

/**
 * An agent CLI's session as a chat, for either terminal engine: its conversation drawn as blocks
 * (`AgentBlockList`), prompts sent through its own channel or typed into its TUI, and what it waits
 * on answered with the CLI's own options.
 *
 * The conversation comes in from `useAgentConversation`, so the chat's logic runs on any value.
 * `run` names the agent command now running in the terminal (its runtime id) — null when none is —
 * so a slash command's "show the TUI" applies to that run alone. `write` types into the PTY; the
 * native engine passes its own, which first returns the grid to the bottom.
 */
export function useAgentChat({
  sessionId,
  run,
  provider,
  agentWaiting,
  conversation,
  write,
  port: given
}: {
  sessionId: string
  run: string | null
  provider?: AgentProviderId
  /** What the agent said while it waits on the person (a permission, a question); null otherwise. */
  agentWaiting?: string | null
  /** The terminal's conversation, from `useAgentConversation`. */
  conversation: AgentConversation | null
  write: (data: string) => void
  /** Where prompts and answers go; `window.api` unless a test passes its own. */
  port?: AgentChatPort
}) {
  const adapter = provider ? conversationAdapter(provider) : undefined
  const port = useMemo(() => given ?? windowChatPort(), [given])
  // The run whose TUI a slash command asked for; the chat steps aside for it.
  const [tuiFor, setTuiFor] = useState<string | null>(null)
  // An agent prompt's Enter goes after its paste (`agentPrompt`); dropped if the view goes first.
  const pendingEnter = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (pendingEnter.current) clearTimeout(pendingEnter.current)
    },
    []
  )
  // Images pasted into the CLI's own input wait there for the prompt, so it must be typed too.
  const [attachedImages, setAttachedImages] = useState(0)
  // Images dropped on the chat: shown as cards, pasted into the CLI's input on the next prompt.
  const [images, setImages] = useState<ChatImage[]>([])
  useEffect(() => {
    setAttachedImages(0)
    setImages([])
  }, [sessionId])
  const nextImage = useRef(0)

  /** Types a prompt into the CLI's own input, for a CLI without a channel or when it refused. */
  const typePrompt = (text: string): void => {
    const { paste, enter } = agentPrompt(text)
    if (pendingEnter.current) clearTimeout(pendingEnter.current)
    write(paste)
    pendingEnter.current = setTimeout(() => {
      pendingEnter.current = null
      port.write(sessionId, enter)
    }, AGENT_ENTER_DELAY_MS)
  }

  const commandSent = useRef<CommandSent | null>(null)
  useEffect(() => {
    const sent = commandSent.current
    if (!sent || !commandSettled(sent, conversation)) return
    commandSent.current = null
    setTuiFor(null)
  }, [conversation])

  const ready = Boolean(run && adapter && conversation)
  const blocks = useMemo(
    () => (conversation && adapter ? agentBlocks(conversation, sessionId, adapter, provider) : []),
    [conversation, adapter, sessionId, provider]
  )
  const approval = useMemo(
    () => approvalRequest(conversation, adapter, agentWaiting ?? null),
    [conversation, adapter, agentWaiting]
  )
  const history = useMemo(
    () => (conversation && adapter ? promptHistory(conversation, adapter) : []),
    [conversation, adapter]
  )

  const onSubmit = (text: string): void => {
    if (images.length > 0) write(imagesPaste(images))
    sendChatPrompt({
      port,
      terminalId: sessionId,
      text,
      conversation,
      attachedImages: attachedImages + images.length,
      type: typePrompt
    })
    setAttachedImages(0)
    setImages([])
    if (isSlashCommand(text) && run && conversation) {
      commandSent.current = { at: conversation.at, messages: conversation.messages.length }
      setTuiFor(run)
    }
  }
  const onAnswer = (option: ApprovalOption): void =>
    answerApproval({ port, terminalId: sessionId, conversation, option })
  const onPasteImage = adapter?.pasteImageKey
    ? () => {
        write(adapter.pasteImageKey!)
        setAttachedImages((count) => count + 1)
      }
    : undefined

  /** Adds dropped images as cards, reading each one's preview as it loads. */
  const attachImages = (dropped: { name: string; quoted: string; file: Blob }[]): void => {
    const added = dropped.map(({ name, quoted, file }) => {
      const id = `image-${nextImage.current++}`
      const reader = new FileReader()
      reader.onload = () => {
        const preview = typeof reader.result === 'string' ? reader.result : undefined
        setImages((current) =>
          current.map((image) => (image.id === id ? { ...image, preview } : image))
        )
      }
      reader.readAsDataURL(file)
      return { id, name, quoted }
    })
    setImages((current) => [...current, ...added])
  }

  return {
    provider,
    adapter,
    conversation,
    attachedImages,
    /** Images dropped on the chat, going with the next prompt. */
    images,
    /** Absent when the CLI takes no images: a dropped image is then only its path. */
    attachImages: adapter?.pasteImageKey ? attachImages : undefined,
    removeImage: (id: string) => setImages((current) => current.filter((image) => image.id !== id)),
    /** An agent runs, its provider can be drawn, and its conversation is being written. */
    ready,
    /** A slash command sent from the chat asked for the CLI's own interface for this run. */
    tuiRequested: run !== null && tuiFor === run,
    blocks,
    approval,
    history,
    working: conversation?.working ?? false,
    onSubmit,
    onAnswer,
    onPasteImage,
    /** Escape, as the CLI takes it: interrupts a turn. */
    onInterrupt: () => port.write(sessionId, '\x1b'),
    /** Shows the CLI's own interface for the running command, until the chat is asked for again. */
    showTui: () => setTuiFor(run),
    /** Drops a slash command's request for the TUI. */
    showChat: () => setTuiFor(null)
  }
}

export type AgentChat = ReturnType<typeof useAgentChat>
