import { describe, expect, it, vi } from 'vitest'
import type { AgentConversation, ApprovalOption } from '@core/agentConversation.js'
import {
  answerApproval,
  commandSettled,
  imagesPaste,
  isImageFile,
  sendChatPrompt,
  watchConversation,
  type AgentChatPort
} from './agentChat.js'

const conversation = (extra: Partial<AgentConversation> = {}): AgentConversation => ({
  at: '2026-11-27T10:00:00.000Z',
  working: false,
  messages: [],
  ...extra
})

type Push = Parameters<Parameters<AgentChatPort['onConversation']>[0]>[0]

/** A port whose first read resolves when the test says, and whose pushes the test sends. */
function fakePort(initial: AgentConversation | null) {
  let resolve: (value: AgentConversation | null) => void = () => {}
  const read = new Promise<AgentConversation | null>((r) => (resolve = r))
  const handlers = new Set<(update: Push) => void>()
  const off = vi.fn()
  const port = {
    conversation: vi.fn(() => read),
    onConversation: vi.fn((handler: (update: Push) => void) => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
        off()
      }
    })
  }
  return {
    port,
    off,
    answerRead: async () => {
      resolve(initial)
      await read
      await Promise.resolve()
    },
    push: (update: Push) => handlers.forEach((handler) => handler(update))
  }
}

describe('watchConversation', () => {
  it('reads the conversation, then follows pushes for its own terminal only', async () => {
    const first = conversation()
    const fake = fakePort(first)
    const set = vi.fn()
    watchConversation(fake.port, 't1', set)
    expect(fake.port.conversation).toHaveBeenCalledWith('t1')
    await fake.answerRead()
    expect(set).toHaveBeenLastCalledWith(first)

    const later = conversation({ working: true })
    fake.push({ terminalId: 'other', conversation: conversation({ messages: [] }) })
    expect(set).toHaveBeenCalledTimes(1)
    fake.push({ terminalId: 't1', conversation: later })
    expect(set).toHaveBeenLastCalledWith(later)
  })

  it('keeps a push that lands before the first read answers', async () => {
    const fake = fakePort(conversation({ at: 'stale' }))
    const set = vi.fn()
    watchConversation(fake.port, 't1', set)
    const pushed = conversation({ at: 'fresh' })
    fake.push({ terminalId: 't1', conversation: pushed })
    await fake.answerRead()
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenLastCalledWith(pushed)
  })

  it('ignores a missing conversation and stops on unsubscribe', async () => {
    const fake = fakePort(null)
    const set = vi.fn()
    const stop = watchConversation(fake.port, 't1', set)
    await fake.answerRead()
    expect(set).not.toHaveBeenCalled()
    stop()
    expect(fake.off).toHaveBeenCalled()
    fake.push({ terminalId: 't1', conversation: conversation() })
    expect(set).not.toHaveBeenCalled()
  })
})

describe('sendChatPrompt', () => {
  const send = async (
    text: string,
    options: { inbox?: boolean; images?: number; sent?: boolean | 'reject' } = {}
  ) => {
    const { inbox = true, images = 0, sent = true } = options
    const port = {
      sendPrompt: vi.fn(() =>
        sent === 'reject' ? Promise.reject(new Error('gone')) : Promise.resolve(sent)
      )
    }
    const type = vi.fn()
    sendChatPrompt({
      port,
      terminalId: 't1',
      text,
      conversation: conversation({ promptInbox: inbox }),
      attachedImages: images,
      type
    })
    await Promise.resolve()
    await Promise.resolve()
    return { port, type }
  }

  it('sends through the inbox as the person’s own words', async () => {
    const { port, type } = await send('Fix the tests')
    expect(port.sendPrompt).toHaveBeenCalledWith('t1', 'Fix the tests')
    expect(type).not.toHaveBeenCalled()
  })

  it('types it when the inbox refuses or fails', async () => {
    expect((await send('Fix it', { sent: false })).type).toHaveBeenCalledWith('Fix it')
    expect((await send('Fix it', { sent: 'reject' })).type).toHaveBeenCalledWith('Fix it')
  })

  it('types without an inbox, for a slash command, and with an image waiting', async () => {
    for (const [text, options] of [
      ['Hello', { inbox: false }],
      ['/compact', {}],
      ['Look at this', { images: 1 }]
    ] as const) {
      const { port, type } = await send(text, options)
      expect(port.sendPrompt).not.toHaveBeenCalled()
      expect(type).toHaveBeenCalledWith(text)
    }
  })
})

describe('answerApproval', () => {
  const allow: ApprovalOption = { id: 'yes', label: 'Yes', kind: 'allow' }
  const deny: ApprovalOption = { id: 'no', label: 'No', kind: 'deny' }
  const port = () => ({ approval: vi.fn(() => Promise.resolve()), write: vi.fn() })

  it('answers the channel’s request by option id', () => {
    const p = port()
    const withRequest = conversation({
      approval: { id: 'a1', prompt: 'Run it?', options: [allow, deny] }
    } as Partial<AgentConversation>)
    answerApproval({ port: p, terminalId: 't1', conversation: withRequest, option: deny })
    expect(p.approval).toHaveBeenCalledWith('t1', 'a1', 'no')
    expect(p.write).not.toHaveBeenCalled()
  })

  it('answers the TUI’s dialog by keys without a channel request', () => {
    const p = port()
    answerApproval({ port: p, terminalId: 't1', conversation: conversation(), option: allow })
    answerApproval({ port: p, terminalId: 't1', conversation: null, option: deny })
    expect(p.write.mock.calls).toEqual([
      ['t1', '\r'],
      ['t1', '\x1b']
    ])
  })
})

describe('commandSettled', () => {
  const sent = { at: 'a', messages: 2 }
  const message = { role: 'user', text: 'x' } as AgentConversation['messages'][number]

  it('waits while the conversation is the one the command was sent against', () => {
    expect(commandSettled(sent, null)).toBe(false)
    expect(commandSettled(sent, conversation({ at: 'a', working: true }))).toBe(false)
    expect(commandSettled(sent, conversation({ at: 'b', messages: [message, message] }))).toBe(
      false
    )
  })

  it('settles once a turn starts or a message is added', () => {
    expect(commandSettled(sent, conversation({ at: 'b', working: true }))).toBe(true)
    expect(commandSettled(sent, conversation({ at: 'b', messages: [message] }))).toBe(true)
  })
})

describe('images dropped on the chat', () => {
  it('tells an image from another file', () => {
    expect(isImageFile({ type: 'image/png' })).toBe(true)
    expect(isImageFile({ type: 'text/plain' })).toBe(false)
  })

  it('pastes their quoted paths as one bracketed paste, as a terminal drop does', () => {
    expect(imagesPaste([{ quoted: "'/a.png'" }, { quoted: "'/b c.png'" }])).toBe(
      "\x1b[200~'/a.png' '/b c.png' \x1b[201~"
    )
  })
})
