import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME } from '@core/types.js'
import type { AgentConversation } from '@core/agentConversation.js'
import { conversationAdapter } from '@core/providers/conversation.js'
import type { AgentChat } from '../lib/agentChat/useAgentChat.js'
import { AgentChatPane, chatGap, type AgentRun } from './AgentChatView.js'
import { AgentBlockList, type ApprovalRequest } from './AgentBlockList.js'
import { ChatSwitch } from './ChatSwitch.js'

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
      theme: DEFAULT_THEME,
      inputRef: createRef<HTMLTextAreaElement>(),
      onShowTerminal: noop
    })
  )

const look = { palette: {} as never, lineHeight: 18 }
const list = (props: { working?: boolean; approval?: ApprovalRequest | null }): string =>
  renderToStaticMarkup(
    createElement(AgentBlockList, {
      blocks: [],
      working: props.working ?? false,
      label: 'Claude Code',
      approval: props.approval ?? null,
      look,
      font: {},
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
    expect(list({ working: true })).toContain('Your message will be queued')
    expect(list({ working: false })).not.toContain('queued')
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
    expect(html).toContain('Answer in Claude Code')
    expect(html).not.toContain('queued')
  })

  it('offers only the terminal for a question asked in the CLI’s own interface', () => {
    const html = list({
      approval: { prompt: 'Claude has a question', options: [], keys: false, inTui: true }
    })
    expect(html).toContain('Answer in Terminal')
    expect(html).not.toContain('>Yes<')
    expect(html).not.toContain('>No<')
  })
})
