import { createElement, createRef, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentConversation } from '@core/agentConversation.js'
import { AgentBlockList } from '../../components/AgentBlockList.js'
import type { AgentChatPort } from './agentChat.js'
import { useAgentChat, type AgentChat } from './useAgentChat.js'

const conversation: AgentConversation = {
  at: '2026-11-27T10:00:00.000Z',
  working: false,
  promptInbox: true,
  commands: [{ name: 'compact', description: 'Compact the chat' }],
  messages: [
    { role: 'user', text: 'Run the tests', toolUses: [] },
    {
      role: 'assistant',
      text: 'Running them now.',
      toolUses: [
        { id: 'tu1', tool: 'Bash', input: { command: 'yarn test' }, text: '12 passed' },
        {
          id: 'tu2',
          tool: 'Edit',
          input: { file_path: 'a.ts', old_string: 'one', new_string: 'two' },
          text: 'ok'
        }
      ]
    },
    { role: 'assistant', text: '## Done\n- all **green**\n```\nyarn test\n```', toolUses: [] },
    { role: 'user', text: 'Thanks', toolUses: [] }
  ],
  approval: {
    id: 'a1',
    prompt: 'Claude wants to run rm -rf build',
    tool: 'Bash',
    input: { command: 'rm -rf build' },
    options: [
      { id: 'yes', label: 'Yes', kind: 'allow' },
      { id: 'no', label: 'No', kind: 'deny' }
    ]
  }
}

type FakePort = { [K in keyof AgentChatPort]: Mock<AgentChatPort[K]> }

const fakePort = (): FakePort => ({
  conversation: vi.fn<AgentChatPort['conversation']>(() => Promise.resolve(null)),
  onConversation: vi.fn<AgentChatPort['onConversation']>(() => () => undefined),
  sendPrompt: vi.fn<AgentChatPort['sendPrompt']>(() => Promise.resolve(true)),
  approval: vi.fn<AgentChatPort['approval']>(() => Promise.resolve()),
  write: vi.fn<AgentChatPort['write']>()
})

/** Renders the hook once and hands back what it returned. */
function probe(props: Partial<Parameters<typeof useAgentChat>[0]>): {
  chat: AgentChat
  port: FakePort
  write: Mock<(data: string) => void>
} {
  const port = fakePort()
  const write = vi.fn<(data: string) => void>()
  let chat: AgentChat | undefined
  function Probe(): ReactNode {
    chat = useAgentChat({
      sessionId: 't1',
      run: 'cmd-1',
      provider: 'claude',
      conversation,
      write,
      port,
      ...props
    })
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return { chat: chat!, port, write }
}

describe('useAgentChat', () => {
  it('is ready with a running agent, its adapter and a conversation', () => {
    expect(probe({}).chat.ready).toBe(true)
    expect(probe({ run: null }).chat.ready).toBe(false)
    expect(probe({ provider: undefined }).chat.ready).toBe(false)
    expect(probe({ conversation: null }).chat.ready).toBe(false)
    expect(probe({}).chat.tuiRequested).toBe(false)
  })

  it('turns the conversation into blocks, the prompt history and the approval', () => {
    const { chat } = probe({})
    expect(chat.blocks.map((block) => block.kind)).toEqual(
      expect.arrayContaining(['agent-message', 'agent-tool-call'])
    )
    expect(chat.history).toEqual(['Run the tests', 'Thanks'])
    expect(chat.approval).toMatchObject({
      prompt: 'Claude wants to run rm -rf build',
      tool: 'Bash',
      keys: false
    })
    expect(chat.approval?.options.map((option) => option.label)).toEqual(['Yes', 'No'])
    expect(chat.working).toBe(false)
    expect(chat.onPasteImage).toBeTypeOf('function')
  })

  it('falls back to the agent status for an approval its channel does not carry', () => {
    const { chat } = probe({
      conversation: { ...conversation, approval: undefined },
      agentWaiting: 'Waiting on you'
    })
    expect(chat.approval).toMatchObject({ prompt: 'Waiting on you', keys: true })
  })

  it('sends a prompt through the inbox and answers an approval by option id', async () => {
    const { chat, port } = probe({})
    chat.onSubmit('Fix it')
    await Promise.resolve()
    expect(port.sendPrompt).toHaveBeenCalledWith('t1', 'Fix it')
    chat.onAnswer({ id: 'no', label: 'No', kind: 'deny' })
    expect(port.approval).toHaveBeenCalledWith('t1', 'a1', 'no')
    chat.onInterrupt()
    expect(port.write).toHaveBeenCalledWith('t1', '\x1b')
  })

  it('types a slash command into the TUI, its Enter after the paste', () => {
    vi.useFakeTimers()
    try {
      const { chat, port, write } = probe({})
      chat.onSubmit('/compact')
      expect(port.sendPrompt).not.toHaveBeenCalled()
      expect(write).toHaveBeenCalledWith(expect.stringContaining('/compact'))
      expect(port.write).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(port.write).toHaveBeenCalledWith('t1', '\r')
    } finally {
      vi.useRealTimers()
    }
  })

  it('pastes an image with the CLI’s own key', () => {
    const { chat, write } = probe({})
    chat.onPasteImage?.()
    expect(write).toHaveBeenCalledWith('\x16')
  })

  it('feeds AgentBlockList: messages, tool calls with output and diff, markdown, approval', () => {
    const { chat } = probe({})
    const html = renderToStaticMarkup(
      createElement(AgentBlockList, {
        blocks: chat.blocks,
        working: chat.working,
        label: 'Claude Code',
        approval: chat.approval,
        inputRef: createRef<HTMLTextAreaElement>(),
        history: chat.history,
        commands: chat.conversation?.commands,
        attachedImages: 2,
        onSubmit: chat.onSubmit,
        onInterrupt: chat.onInterrupt,
        onAnswer: chat.onAnswer,
        onPasteImage: chat.onPasteImage,
        onShowTui: () => undefined
      })
    )
    expect(html).toContain('Run the tests')
    expect(html).toContain('yarn test')
    // Tool calls fold to a line, as on the phone; the edit's row counts its change.
    expect(html).toContain('aria-label="Bash yarn test, completed"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('+1')
    expect(html).toContain('<pre')
    expect(html).toContain('<li>all <strong')
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('2 images')
  })
})
