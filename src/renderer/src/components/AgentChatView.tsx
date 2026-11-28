import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MutableRefObject,
  type ReactNode
} from 'react'
import { syntaxFor, type ShellDialect } from '@core/shell.js'
import { AGENT_PROVIDER_LABELS } from '@core/types.js'
import type { AgentProviderId } from '@core/providers/types.js'
import {
  useAgentChat,
  useAgentConversation,
  type AgentChat
} from '../lib/agentChat/useAgentChat.js'
import { droppedText } from '../lib/nativeTerminal/pointerMath.js'
import { AgentBlockList } from './AgentBlockList.js'
import type { TerminalHandle } from './TerminalView.js'

/** The agent a tab runs, as the surface knows it, for its chat. */
export interface AgentRun {
  /** The runtime's id for the agent command now running; null once it has exited. */
  id: string | null
  provider: AgentProviderId
  /** What the agent said while it waits on the person; null otherwise. */
  waiting?: string | null
}

/** What a chat cannot draw, as the pane says it; null when it can draw the conversation. */
export function chatGap(
  chat: Pick<AgentChat, 'adapter' | 'conversation'>,
  run: AgentRun
): string | null {
  const label = AGENT_PROVIDER_LABELS[run.provider]
  if (!chat.adapter) return `Chat can’t show ${label} sessions yet.`
  if (!run.id) return `${label} isn’t running in this tab.`
  if (!chat.conversation) return `Waiting for ${label}’s conversation…`
  return null
}

/**
 * Files dropped on the chat: their paths, quoted in the tab's shell dialect as the terminal quotes
 * a drop, go into the message field at the cursor. The person sees what will be sent, and the
 * prompt reaches the CLI the way any chat prompt does. Nothing happens without a field to fill.
 */
export function dropFilesIntoChat(
  event: Pick<DragEvent, 'dataTransfer' | 'preventDefault'>,
  input: HTMLTextAreaElement | null,
  dialect: ShellDialect | undefined,
  pathsFor: (files: File[]) => string[] = (files) => window.api.terminal.pathsForFiles(files)
): void {
  const files = Array.from(event.dataTransfer.files)
  if (files.length === 0) return
  event.preventDefault()
  const paths = pathsFor(files)
  if (paths.length === 0 || !input) return
  input.focus()
  // insertText keeps the field's undo and fires its input event, so React sees the change.
  document.execCommand(
    'insertText',
    false,
    droppedText(paths, (path) => syntaxFor(dialect).quote(path))
  )
}

/** A drag carrying files may drop on the chat (it copies their paths, it moves nothing). */
function allowFileDrop(event: DragEvent): void {
  if (!event.dataTransfer.types.includes('Files')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
}

/**
 * The xterm.js engine's chat for an agent tab: it lies over the terminal, which stays mounted
 * underneath — only hidden (`onShownChange`), so its scrollback, scroll position and PTY are
 * untouched. It draws the phone app's chat with `AgentBlockList`, fed by `useAgentChat`, the hook the native engine uses
 * too, and stays mounted once shown, so it keeps its scroll position as well. A slash command that
 * opens the CLI's own interface shows the terminal until the conversation moves on.
 */
export function XtermAgentChat({
  sessionId,
  run,
  chat,
  active,
  handle,
  onChatChange,
  onShownChange,
  dialect
}: {
  sessionId: string
  run: AgentRun
  /** The tab's Chat switch. */
  chat: boolean
  active: boolean
  /** The terminal's handle, to give it focus back when the chat steps aside. */
  handle?: MutableRefObject<TerminalHandle | null>
  onChatChange: (on: boolean) => void
  /** The chat started (true) or stopped covering the terminal, which hides beneath it. */
  onShownChange: (shown: boolean) => void
  /** The tab's shell dialect, which quotes a dropped file's path. */
  dialect?: ShellDialect
}): ReactNode {
  const agent = useAgentChat({
    sessionId,
    run: run.id,
    provider: run.provider,
    agentWaiting: run.waiting,
    conversation: useAgentConversation(sessionId),
    write: (data) => window.api.terminal.write(sessionId, data)
  })
  const showChat = chat && !agent.tuiRequested
  // Mounted the first time it shows and kept after, so switching back finds it where it was.
  const [mounted, setMounted] = useState(showChat)
  const onShownRef = useRef(onShownChange)
  onShownRef.current = onShownChange
  useEffect(() => {
    if (showChat) setMounted(true)
    onShownRef.current(showChat)
  }, [showChat])
  // Gone (the agent tab became a shell again): the terminal shows.
  useEffect(() => () => onShownRef.current(false), [])

  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (!active) return
    // Whichever view shows takes the keys, so switching leaves the person typing.
    const frame = requestAnimationFrame(() =>
      showChat ? inputRef.current?.focus() : handle?.current?.focus()
    )
    return () => cancelAnimationFrame(frame)
  }, [active, showChat, handle])

  return (
    <>
      {mounted ? (
        <div
          className={`absolute inset-0 ${showChat && active ? '' : 'invisible'}`}
          aria-hidden={!showChat || undefined}
          data-agent-chat
        >
          <AgentChatPane
            agent={agent}
            run={run}
            inputRef={inputRef}
            dialect={dialect}
            onShowTerminal={() => onChatChange(false)}
          />
        </div>
      ) : null}
      {chat && agent.tuiRequested && active ? <BackToChat onClick={agent.showChat} /> : null}
    </>
  )
}

/** The chat itself, or why it cannot draw this session with the way back to the terminal. */
export function AgentChatPane({
  agent,
  run,
  inputRef,
  dialect,
  onShowTerminal
}: {
  agent: AgentChat
  run: AgentRun
  inputRef: MutableRefObject<HTMLTextAreaElement | null>
  /** The tab's shell dialect, which quotes a dropped file's path. */
  dialect?: ShellDialect
  onShowTerminal: () => void
}): ReactNode {
  const label = AGENT_PROVIDER_LABELS[run.provider]
  const gap = chatGap(agent, run)
  return (
    <div
      role="region"
      aria-label={`${label} chat`}
      className="bg-surface text-ink h-full w-full overflow-hidden"
      onDragOver={allowFileDrop}
      onDrop={(event) => dropFilesIntoChat(event, gap ? null : inputRef.current, dialect)}
    >
      {gap ? (
        <ChatGap text={gap} label={label} onShowTerminal={onShowTerminal} />
      ) : (
        <AgentBlockList
          blocks={agent.blocks}
          working={agent.working}
          label={label}
          approval={agent.approval}
          inputRef={inputRef}
          history={agent.history}
          commands={agent.conversation?.commands}
          attachedImages={agent.attachedImages}
          onSubmit={agent.onSubmit}
          onInterrupt={agent.onInterrupt}
          onAnswer={agent.onAnswer}
          onPasteImage={agent.onPasteImage}
          onShowTui={onShowTerminal}
        />
      )}
    </div>
  )
}

/** Said instead of failing silently: what the chat cannot show, and the terminal that can. */
function ChatGap({
  text,
  label,
  onShowTerminal
}: {
  text: string
  label: string
  onShowTerminal: () => void
}): ReactNode {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-2 p-4 font-sans"
    >
      <span className="text-dim text-center text-[12.5px]">{text}</span>
      <span className="text-faint text-center text-[11.5px]">
        The terminal shows everything {label} draws.
      </span>
      <button
        type="button"
        className="border-edge-strong text-ink hover:bg-raised/70 mt-1 inline-flex h-[24px] items-center rounded-md border px-2.5 text-[12px] font-medium"
        onClick={onShowTerminal}
      >
        Switch to Terminal
      </button>
    </div>
  )
}

/** Shown over the CLI's own interface after a slash command opened it, to return early. */
export function BackToChat({ onClick }: { onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      className="bg-raised text-dim border-edge-strong hover:text-ink absolute top-2 right-3 z-10 rounded-md border px-2 py-0.5 font-sans text-[11.5px]"
      onClick={onClick}
    >
      Back to chat
    </button>
  )
}
