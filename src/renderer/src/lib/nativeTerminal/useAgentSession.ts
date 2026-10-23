import { useEffect, useMemo, useRef, useState } from 'react'
import { agentProgramProvider } from '@core/handoff.js'
import {
  agentBlocks,
  type AgentConversation,
  type ApprovalOption
} from '@core/agentConversation.js'
import { conversationAdapter } from '@core/providers/conversation.js'
import type { AgentProviderId } from '@core/providers/types.js'
import type { BlockListState } from './blockList.js'
import { AGENT_ENTER_DELAY_MS, agentPrompt, promptRoute } from './commandInput.js'
import { isSlashCommand } from './commandMenu.js'
import { approvalRequest } from './agentApproval.js'

/** The conversation of the agent CLI in a terminal, as its provider's source writes it. */
function useAgentConversation(sessionId: string): AgentConversation | null {
  const [conversation, setConversation] = useState<AgentConversation | null>(null)
  useEffect(() => {
    let live = true
    setConversation(null)
    void window.api.usage.conversation(sessionId).then((value) => {
      if (live && value) setConversation(value)
    })
    const off = window.api.usage.onConversation(({ terminalId, conversation: value }) => {
      if (terminalId === sessionId) setConversation(value)
    })
    return () => {
      live = false
      off()
    }
  }, [sessionId])
  return conversation
}

/**
 * An agent CLI running in the block list: drawn by Styr from its conversation when its provider has
 * an adapter and the conversation is being written; otherwise, or on request, its own TUI shows.
 */
export function useAgentSession({
  sessionId,
  list,
  agentProvider,
  agentWaiting,
  write
}: {
  sessionId: string
  list: BlockListState | null
  agentProvider?: AgentProviderId
  agentWaiting?: string | null
  write: (data: string) => void
}) {
  const running = list?.active.kind === 'running' ? list.active : null
  const provider = running ? (agentProgramProvider(running.command) ?? agentProvider) : undefined
  const adapter = provider ? conversationAdapter(provider) : undefined
  const conversation = useAgentConversation(sessionId)
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
  useEffect(() => setAttachedImages(0), [sessionId])
  const sendAgentPrompt = (text: string): void => {
    const inbox = conversation?.promptInbox === true && attachedImages === 0
    setAttachedImages(0)
    // Through the agent's own channel when it has one, so the prompt is the person's own words.
    if (promptRoute(text, inbox) === 'inbox') {
      void window.api.usage.sendPrompt(sessionId, text).then((sent) => {
        if (!sent) typeAgentPrompt(text)
      })
      return
    }
    typeAgentPrompt(text)
  }
  /** Types a prompt into the CLI's own input, for a CLI without a channel or when it refused. */
  const typeAgentPrompt = (text: string): void => {
    const { paste, enter } = agentPrompt(text)
    if (pendingEnter.current) clearTimeout(pendingEnter.current)
    write(paste)
    pendingEnter.current = setTimeout(() => {
      pendingEnter.current = null
      window.api.terminal.write(sessionId, enter)
    }, AGENT_ENTER_DELAY_MS)
  }
  const commandSent = useRef<{ at: string; messages: number } | null>(null)
  useEffect(() => {
    const sent = commandSent.current
    if (!sent || !conversation || conversation.at === sent.at) return
    if (conversation.working || conversation.messages.length !== sent.messages) {
      commandSent.current = null
      setTuiFor(null)
    }
  }, [conversation])
  const agentReady = Boolean(running && adapter && conversation)
  const agentMode = agentReady && tuiFor !== running?.id
  const agentBlockList = useMemo(
    () => (conversation && adapter ? agentBlocks(conversation, sessionId, adapter, provider) : []),
    [conversation, adapter, sessionId, provider]
  )
  const approval = useMemo(
    () => approvalRequest(conversation, adapter, agentWaiting ?? null),
    [conversation, adapter, agentWaiting]
  )

  const onSubmit = (text: string): void => {
    sendAgentPrompt(text)
    // A command may answer in the CLI's own interface (a picker, a dialog), which only its
    // view draws: show it, and come back once the conversation moves on.
    if (isSlashCommand(text) && running && conversation) {
      commandSent.current = { at: conversation.at, messages: conversation.messages.length }
      setTuiFor(running.id)
    }
  }
  const onAnswer = (option: ApprovalOption): void => {
    if (conversation?.approval)
      // Already answered in the CLI's own view when this fails: nothing left to do.
      window.api.usage.approval(sessionId, conversation.approval.id, option.id).catch(() => {})
    // The TUI's dialog: Enter takes its default (allow once), Escape refuses.
    else window.api.terminal.write(sessionId, option.kind === 'deny' ? '\x1b' : '\r')
  }
  const onPasteImage = adapter?.pasteImageKey
    ? () => {
        write(adapter.pasteImageKey!)
        setAttachedImages((count) => count + 1)
      }
    : undefined

  return {
    running,
    provider,
    adapter,
    conversation,
    attachedImages,
    agentReady,
    agentMode,
    agentBlockList,
    approval,
    onSubmit,
    onAnswer,
    onPasteImage,
    /** Shows the CLI's own interface for the running command. */
    showTui: () => setTuiFor(running?.id ?? null),
    /** Goes back to Styr's view. */
    showStyrView: () => setTuiFor(null)
  }
}
