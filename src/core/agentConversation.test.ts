import { describe, expect, it } from 'vitest'
import {
  agentBlocks,
  editPatch,
  lineCount,
  parseAgentConversation,
  promptHistory,
  type AgentConversation,
  type ConversationAdapter
} from './agentConversation.js'

const file = (working: boolean, messages: unknown[]): string =>
  JSON.stringify({ at: '2026-10-10T08:00:00.000Z', working, messages })

/** An adapter for a made-up CLI: nothing here may depend on a real one. */
const adapter: ConversationAdapter = {
  promptText: (raw) => raw.replace(/^\[note\].*$/m, '').trim(),
  describeTool: (use) => ({
    summary: String(use.input.target ?? ''),
    ...(use.text !== undefined ? { result: lineCount(use.text) } : {}),
    ...(use.tool === 'change'
      ? { edit: { path: String(use.input.target), patch: '+x', additions: 1, deletions: 0 } }
      : {})
  })
}

describe('parseAgentConversation', () => {
  it('reads the neutral file and drops what is not a message', () => {
    const parsed = parseAgentConversation(
      file(true, [
        { role: 'user', text: 'fix the watcher', toolUses: [] },
        { role: 'system', text: 'x' },
        'junk',
        {
          role: 'assistant',
          text: 'On it.',
          toolUses: [
            { id: 't1', tool: 'look', input: { target: '/a.ts', limit: 5, nested: { x: 1 } } },
            { id: 3, tool: 'bad' }
          ]
        }
      ])
    )
    expect(parsed).toEqual({
      at: '2026-10-10T08:00:00.000Z',
      working: true,
      messages: [
        { role: 'user', text: 'fix the watcher', toolUses: [] },
        {
          role: 'assistant',
          text: 'On it.',
          toolUses: [{ id: 't1', tool: 'look', input: { target: '/a.ts', limit: 5 } }]
        }
      ]
    })
  })

  it('reads the commands the CLI offers, and drops ones that are not names', () => {
    const parsed = parseAgentConversation(
      JSON.stringify({
        at: '',
        working: false,
        messages: [],
        commands: [
          { name: 'compact', description: 'Summarise' },
          { name: '/review', description: 'Review a PR' },
          { name: 'rm -rf', description: 'no' },
          { description: 'nameless' },
          'junk'
        ]
      })
    )
    expect(parsed?.commands).toEqual([
      { name: 'compact', description: 'Summarise' },
      { name: 'review', description: 'Review a PR' }
    ])
    expect(parseAgentConversation(file(false, []))?.commands).toBeUndefined()
    expect(parseAgentConversation(file(false, []))?.promptInbox).toBeUndefined()
    expect(
      parseAgentConversation(JSON.stringify({ at: '', messages: [], promptInbox: true }))
        ?.promptInbox
    ).toBe(true)
  })

  it('refuses what is not a conversation file', () => {
    expect(parseAgentConversation('not json')).toBeNull()
    expect(parseAgentConversation('[]')).toBeNull()
    expect(parseAgentConversation('{"messages": 3}')).toBeNull()
  })

  it('bounds what it keeps', () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      role: 'user',
      text: `m${index}${'x'.repeat(20_000)}`,
      toolUses: []
    }))
    const parsed = parseAgentConversation(file(false, many))!
    expect(parsed.messages).toHaveLength(300)
    expect(parsed.messages[0]!.text.startsWith('m100')).toBe(true)
    expect(parsed.messages[0]!.text.length).toBe(8000)
  })
})

describe('conversation helpers', () => {
  it('turns edits into a patch with counts', () => {
    expect(editPatch([{ old: 'a\nb', next: 'a\nc\nd' }])).toEqual({
      patch: '-a\n-b\n+a\n+c\n+d',
      additions: 3,
      deletions: 2
    })
    expect(
      editPatch([
        { old: 'a', next: 'b' },
        { old: 'c', next: '' }
      ])
    ).toEqual({ patch: '-a\n+b\n@@\n-c', additions: 1, deletions: 2 })
    expect(editPatch([])).toBeNull()
  })

  it('counts lines with something on them', () => {
    expect(lineCount('a\n\nb\n')).toBe('2 lines')
    expect(lineCount('a')).toBe('1 line')
    expect(lineCount('  \n')).toBe('no output')
  })
})

describe('agentBlocks', () => {
  const conversation = (working: boolean): AgentConversation => ({
    at: '2026-10-10T08:00:00.000Z',
    working,
    messages: [
      { role: 'user', text: '[note] internal\nRename the helper', toolUses: [] },
      {
        role: 'assistant',
        text: 'Looking at it.',
        toolUses: [
          { id: 'r1', tool: 'look', input: { target: '/a.ts' }, text: 'one\ntwo' },
          { id: 'e1', tool: 'change', input: { target: '/a.ts' } }
        ]
      },
      // A user message that only carries tool results says nothing to the person.
      { role: 'user', text: '', toolUses: [] }
    ]
  })

  it('lays out prompts, messages, tool calls and diffs in order, as the adapter reads them', () => {
    const blocks = agentBlocks(conversation(true), 's1', adapter, 'codex')
    expect(blocks.map((block) => `${block.kind}:${block.id}:${block.state}`)).toEqual([
      'agent-message:m0:completed',
      'agent-message:m1:completed',
      'agent-tool-call:r1:completed',
      'agent-tool-call:e1:streaming',
      'diff:e1:diff:streaming'
    ])
    expect(blocks[0]).toMatchObject({
      sessionId: 's1',
      payload: { role: 'user', text: 'Rename the helper', provider: 'codex' }
    })
    expect(blocks[2]).toMatchObject({
      payload: { tool: 'look', summary: '/a.ts', result: '2 lines' }
    })
    expect(blocks[4]).toMatchObject({ parentId: 'e1', payload: { path: '/a.ts', additions: 1 } })
  })

  it('marks a call left without a result as cut short once the turn is over', () => {
    const blocks = agentBlocks(conversation(false), 's1', adapter)
    expect(blocks.find((block) => block.id === 'e1')?.state).toBe('cancelled')
  })

  it('collects the person’s prompts for history, without repeats', () => {
    const base = conversation(false)
    expect(
      promptHistory(
        {
          ...base,
          messages: [...base.messages, { role: 'user', text: 'Rename the helper', toolUses: [] }]
        },
        adapter
      )
    ).toEqual(['Rename the helper'])
  })
})
