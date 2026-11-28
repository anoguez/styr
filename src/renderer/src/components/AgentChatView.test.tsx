import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConversation } from '@core/agentConversation.js'
import { conversationAdapter } from '@core/providers/conversation.js'
import type { AgentChat } from '../lib/agentChat/useAgentChat.js'
import {
  AgentChatPane,
  BackToChat,
  XtermAgentChat,
  chatGap,
  dropFilesIntoChat,
  type AgentRun
} from './AgentChatView.js'
import { AgentBlockList, type ApprovalRequest } from './AgentBlockList.js'
import { ChatSwitch } from './ChatSwitch.js'
import type { BlockState, StyrBlock } from '@core/types/blocks.js'

const envelope = { sessionId: 't1', createdAt: 0, updatedAt: 0 }
const message = (id: string, role: 'user' | 'assistant', text: string): StyrBlock => ({
  ...envelope,
  id,
  state: 'completed',
  kind: 'agent-message',
  payload: { role, text }
})
const toolCall = (
  id: string,
  tool: string,
  summary: string,
  state: BlockState = 'completed'
): StyrBlock => ({
  ...envelope,
  id,
  state,
  kind: 'agent-tool-call',
  payload: { tool, summary }
})

const noop = (): void => undefined
const claude = conversationAdapter('claude')
const run: AgentRun = { id: 'cmd-1', provider: 'claude' }
const conversation: AgentConversation = {
  at: '2026-11-27T10:00:00.000Z',
  working: false,
  messages: [
    { role: 'assistant', text: 'All tests pass.' } as AgentConversation['messages'][number]
  ]
}

/** What `useAgentChat` returns, with only the fields a test sets differing. */
const chat = (extra: Partial<AgentChat> = {}): AgentChat => ({
  provider: 'claude',
  adapter: claude,
  conversation,
  attachedImages: 0,
  images: [],
  attachImages: undefined,
  removeImage: noop,
  ready: true,
  tuiRequested: false,
  blocks: [],
  approval: null,
  history: [],
  working: false,
  onSubmit: noop,
  onAnswer: noop,
  onPasteImage: undefined,
  onInterrupt: noop,
  showTui: noop,
  showChat: noop,
  ...extra
})

const pane = (agent: AgentChat, agentRun: AgentRun = run): string =>
  renderToStaticMarkup(
    createElement(AgentChatPane, {
      agent,
      run: agentRun,
      inputRef: createRef<HTMLTextAreaElement>(),
      onShowTerminal: noop
    })
  )

const list = (props: {
  working?: boolean
  approval?: ApprovalRequest | null
  blocks?: StyrBlock[]
}): string =>
  renderToStaticMarkup(
    createElement(AgentBlockList, {
      blocks: props.blocks ?? [],
      working: props.working ?? false,
      label: 'Claude Code',
      approval: props.approval ?? null,
      inputRef: createRef<HTMLTextAreaElement>(),
      history: [],
      onSubmit: noop,
      onInterrupt: noop,
      onAnswer: noop,
      onShowTui: noop
    })
  )

describe('Chat switch', () => {
  it('is a labelled switch that says which view shows and its key', () => {
    const on = renderToStaticMarkup(
      createElement(ChatSwitch, { on: true, hint: '⌘⇧T', onToggle: noop })
    )
    expect(on).toContain('role="switch"')
    expect(on).toContain('aria-checked="true"')
    expect(on).toContain('aria-label="Chat"')
    expect(on).toContain('Showing the chat')
    expect(on).toContain('(⌘⇧T)')
    const off = renderToStaticMarkup(
      createElement(ChatSwitch, { on: false, hint: '', onToggle: noop })
    )
    expect(off).toContain('aria-checked="false"')
    expect(off).toContain('Showing the terminal')
    expect(off).not.toContain('()')
  })
})

describe('chat pane', () => {
  it('draws the conversation with the agent’s input', () => {
    const html = pane(chat())
    expect(html).toContain('aria-label="Claude Code chat"')
    expect(html).toContain('aria-label="Message Claude Code"')
    expect(html).not.toContain('Switch to Terminal')
  })

  it('says what it cannot show, with the way back to the terminal', () => {
    expect(chatGap(chat({ adapter: undefined }), run)).toMatch(/can’t show Claude Code/)
    expect(chatGap(chat(), { ...run, id: null })).toMatch(/isn’t running/)
    expect(chatGap(chat({ conversation: null }), run)).toMatch(/Waiting for Claude Code/)
    expect(chatGap(chat(), run)).toBeNull()
    for (const agent of [chat({ adapter: undefined }), chat({ conversation: null })]) {
      const html = pane(agent)
      expect(html).toContain('role="status"')
      expect(html).toContain('Switch to Terminal')
      expect(html).not.toContain('Message Claude Code')
    }
  })
})

describe('agent block list', () => {
  it('says a message will be queued while the agent works', () => {
    expect(list({ working: true })).toContain('your message will be queued')
    expect(list({ working: false })).not.toContain('queued')
  })

  it('draws a chat: the person’s bubble, the agent’s reply across the column, folded tool calls', () => {
    const html = list({
      blocks: [
        message('m1', 'user', 'Debounce the watcher'),
        message('m2', 'assistant', 'I found **the watcher**.'),
        toolCall('t1', 'Read', 'src/main/watcher.ts'),
        toolCall('t2', 'Bash', 'npm test', 'failed')
      ]
    })
    expect(html).toMatch(/aria-label="Your message"[^>]*justify-end/)
    expect(html).toContain('rounded-br-[4px]')
    expect(html).toContain('<strong')
    expect(html).toContain('aria-label="Copy message"')
    expect(html).toContain('aria-label="Read src/main/watcher.ts, completed"')
    // A failed call is outlined in the danger colour and marked with a cross, not colour alone.
    expect(html).toMatch(/Bash npm test, failed.*border-danger/)
    expect(html).toContain('✕')
    // The conversation fills the tab, however wide or narrow the panel is docked.
    expect(html).not.toContain('max-w-[800px]')
    expect(html).toContain('w-full px-4')
    expect(html).not.toContain('Nothing here yet')
  })

  it('puts Styr’s avatar on the first row of each of the agent’s turns', () => {
    const html = list({
      working: true,
      blocks: [
        message('m1', 'user', 'One'),
        message('m2', 'assistant', 'Reply'),
        toolCall('t1', 'Read', 'a.ts'),
        message('m3', 'user', 'Two')
      ]
    })
    // The first turn's reply, and "Working…" starting the second.
    expect(html.match(/bg-accent\/15 grid size-7/g)).toHaveLength(2)
    // Your messages have none.
    expect(list({ blocks: [message('m1', 'user', 'One')] })).not.toContain('size-[18px]')
  })

  it('says “Working…” in a line while a turn runs, and invites a first message when empty', () => {
    expect(list({ working: true })).toContain('Working…')
    expect(list({ working: true })).toContain('Interrupt')
    expect(list({})).not.toContain('Working…')
    expect(list({})).toContain('Nothing here yet')
  })

  it('offers the CLI’s own options for an approval', () => {
    const html = list({
      approval: {
        prompt: 'Run npm test?',
        options: [
          { id: 'yes', label: 'Yes', kind: 'allow' },
          { id: 'always', label: 'Yes, and don’t ask again', kind: 'allow-always' },
          { id: 'no', label: 'No', kind: 'deny' }
        ],
        keys: false
      }
    })
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('Yes, and don’t ask again')
    expect(html).toContain('Waiting on you')
    // Deny beside the wider Allow, as on the phone's card.
    expect(html).toMatch(/text-danger[^>]*><span class="truncate">No</)
    expect(html).toMatch(/flex-\[2\]"><span class="truncate">Yes</)
    expect(html).toContain('Answer in Claude Code')
    expect(html).not.toContain('queued')
  })

  it('offers only the terminal for a question asked in the CLI’s own interface', () => {
    const html = list({
      approval: { prompt: 'Claude has a question', options: [], keys: false, inTui: true }
    })
    expect(html).toContain('Answer in Terminal')
    expect(html).toContain('Asked you a question')
    expect(html).toContain('A message sent now waits')
    expect(html).not.toContain('>Yes<')
    expect(html).not.toContain('>No<')
  })
})

describe('xterm.js chat overlay', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        usage: {
          conversation: () => Promise.resolve(null),
          onConversation: () => () => undefined,
          sendPrompt: () => Promise.resolve(true),
          approval: () => Promise.resolve()
        },
        terminal: { write: () => undefined }
      }
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const overlay = (chatOn: boolean, active = true): string =>
    renderToStaticMarkup(
      createElement(XtermAgentChat, {
        sessionId: 't1',
        run,
        chat: chatOn,
        active,
        onChatChange: noop,
        onShownChange: noop
      })
    )

  it('lies over the terminal while Chat is on, saying what it waits for', () => {
    const html = overlay(true)
    expect(html).toContain('data-agent-chat')
    expect(html).not.toContain('invisible')
    // No conversation has arrived yet in a static render: the way back is offered.
    expect(html).toContain('Waiting for Claude Code')
    expect(html).toContain('Switch to Terminal')
  })

  it('is not drawn until Chat is first switched on, and hides in a background tab', () => {
    expect(overlay(false)).toBe('')
    expect(overlay(true, false)).toContain('invisible')
  })

  it('offers a way back to the chat over the TUI', () => {
    expect(renderToStaticMarkup(createElement(BackToChat, { onClick: noop }))).toContain(
      'Back to chat'
    )
  })
})

describe('dropping files on the chat', () => {
  afterEach(() => vi.unstubAllGlobals())

  const file = (name: string, type: string): File => ({ name, type }) as File
  const drop = (files: File[]) => ({
    dataTransfer: { files } as never,
    preventDefault: vi.fn()
  })
  const paths = new Map<File, string>()
  const pathsFor = (files: File[]): string[] => files.map((f) => paths.get(f) ?? '')

  it('puts the quoted path of a file that is not an image into the message field', () => {
    const execCommand = vi.fn()
    vi.stubGlobal('document', { execCommand })
    const input = { focus: vi.fn() } as unknown as HTMLTextAreaElement
    const notes = file('my notes.txt', 'text/plain')
    paths.set(notes, '/tmp/my notes.txt')
    const attach = vi.fn()
    const event = drop([notes])
    dropFilesIntoChat(event, input, 'posix', attach, pathsFor)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(input.focus).toHaveBeenCalled()
    expect(execCommand).toHaveBeenCalledWith('insertText', false, "'/tmp/my notes.txt' ")
    expect(attach).not.toHaveBeenCalled()
  })

  it('makes an image a card, and its path text only when the CLI takes no images', () => {
    const execCommand = vi.fn()
    vi.stubGlobal('document', { execCommand })
    const input = { focus: vi.fn() } as unknown as HTMLTextAreaElement
    const shot = file('shot.png', 'image/png')
    paths.set(shot, '/tmp/shot.png')
    const attach = vi.fn()
    dropFilesIntoChat(drop([shot]), input, 'posix', attach, pathsFor)
    expect(attach).toHaveBeenCalledWith([
      { name: 'shot.png', quoted: "'/tmp/shot.png'", file: shot }
    ])
    expect(execCommand).not.toHaveBeenCalled()
    dropFilesIntoChat(drop([shot]), input, 'posix', undefined, pathsFor)
    expect(execCommand).toHaveBeenCalledWith('insertText', false, "'/tmp/shot.png' ")
  })

  it('leaves a drag without files, or a chat without a field, alone', () => {
    const execCommand = vi.fn()
    vi.stubGlobal('document', { execCommand })
    const none = drop([])
    dropFilesIntoChat(none, null, 'posix', undefined, pathsFor)
    expect(none.preventDefault).not.toHaveBeenCalled()
    const shot = file('shot.png', 'image/png')
    paths.set(shot, '/tmp/shot.png')
    const attach = vi.fn()
    dropFilesIntoChat(drop([shot]), null, 'posix', attach, pathsFor)
    expect(execCommand).not.toHaveBeenCalled()
    expect(attach).not.toHaveBeenCalled()
  })

  it('draws dropped images as cards above the field, with a way to remove one', () => {
    const html = renderToStaticMarkup(
      createElement(AgentBlockList, {
        blocks: [],
        working: false,
        label: 'Claude Code',
        approval: null,
        inputRef: createRef<HTMLTextAreaElement>(),
        history: [],
        images: [
          {
            id: 'i1',
            name: 'shot.png',
            quoted: "'/tmp/shot.png'",
            preview: 'data:image/png;base64,AA'
          },
          { id: 'i2', name: 'later.png', quoted: "'/tmp/later.png'" }
        ],
        onRemoveImage: noop,
        onSubmit: noop,
        onInterrupt: noop,
        onAnswer: noop,
        onShowTui: noop
      })
    )
    expect(html).toContain('aria-label="Images to send"')
    expect(html).toContain('src="data:image/png;base64,AA"')
    expect(html).toContain('aria-label="Remove shot.png"')
    expect(html).not.toContain('/tmp/shot.png')
  })
})
