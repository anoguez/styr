import { describe, expect, it } from 'vitest'
import { agentBlocks, parseAgentConversation } from '../agentConversation.js'
import { conversationAdapter } from './conversation.js'
import { codexConversation, codexConversationFromThread } from './codexConversation.js'

const thread = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  thread: { updatedAt: 1_800_000_000, status: { type: 'idle' }, turns: [{ items }], ...extra }
})

describe('codexConversationFromThread', () => {
  it('maps Codex thread items to bounded neutral messages and tool calls', () => {
    const conversation = codexConversationFromThread(
      thread(
        [
          { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Fix the bug' }] },
          { id: 'a1', type: 'agentMessage', text: 'I will inspect it.' },
          {
            id: 'c1',
            type: 'commandExecution',
            command: 'rg TODO src',
            aggregatedOutput: 'src/a.ts: TODO',
            status: 'completed',
            exitCode: 0
          },
          {
            id: 'f1',
            type: 'fileChange',
            status: 'completed',
            changes: [{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' }]
          }
        ],
        { status: { type: 'active' } }
      )
    )

    expect(conversation).toMatchObject({
      at: new Date(1_800_000_000_000).toISOString(),
      working: true,
      promptInbox: true
    })
    expect(conversation?.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(conversation?.messages[1]?.toolUses).toEqual([
      { id: 'c1', tool: 'shell', input: { command: 'rg TODO src' }, text: 'src/a.ts: TODO' },
      {
        id: 'f1:0',
        tool: 'apply_patch',
        input: { file_path: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
        text: ''
      }
    ])
    expect(agentBlocks(conversation!, 'terminal-1', codexConversation).at(-1)).toMatchObject({
      kind: 'diff',
      payload: { path: 'src/a.ts', additions: 1, deletions: 1 }
    })
  })

  it('leaves a running command unfinished and not failed, and flags a non-zero exit', () => {
    const conversation = codexConversationFromThread(
      thread([
        {
          id: 'c1',
          type: 'commandExecution',
          command: 'yarn test',
          status: 'inProgress',
          exitCode: null
        },
        { id: 'c2', type: 'commandExecution', command: 'false', status: 'completed', exitCode: 1 }
      ])
    )
    const [running, failed] = conversation!.messages[0]!.toolUses
    expect(running).toEqual({ id: 'c1', tool: 'shell', input: { command: 'yarn test' } })
    expect(failed).toMatchObject({ id: 'c2', isError: true, text: '' })
  })

  it('reads MCP and dynamic tool results and a declined file change', () => {
    const [mcp, failedMcp, dynamic, declined] = codexConversationFromThread(
      thread([
        {
          id: 'm1',
          type: 'mcpToolCall',
          server: 'styr',
          tool: 'get_task',
          arguments: { id: 'TASK-1' },
          status: 'completed',
          result: { content: [{ type: 'text', text: 'a\nb' }] },
          error: null
        },
        {
          id: 'm2',
          type: 'mcpToolCall',
          tool: 'get_task',
          arguments: {},
          status: 'failed',
          result: null,
          error: { message: 'not found' }
        },
        {
          id: 'd1',
          type: 'dynamicToolCall',
          tool: 'lookup',
          arguments: { q: 'x' },
          status: 'completed',
          success: true,
          contentItems: [{ type: 'inputText', text: 'found' }]
        },
        {
          id: 'f1',
          type: 'fileChange',
          status: 'declined',
          changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '+x' }]
        }
      ])
    )!.messages[0]!.toolUses
    expect(mcp).toEqual({ id: 'm1', tool: 'get_task', input: { id: 'TASK-1' }, text: 'a\nb' })
    expect(failedMcp).toMatchObject({ text: 'not found', isError: true })
    expect(dynamic).toEqual({ id: 'd1', tool: 'lookup', input: { q: 'x' }, text: 'found' })
    expect(declined).toMatchObject({ id: 'f1:0', text: '', isError: true })
  })

  it('keeps the newest messages of a long thread', () => {
    const turns = Array.from({ length: 250 }, (_, index) => ({
      items: [
        { id: `u${index}`, type: 'userMessage', content: [{ type: 'text', text: `ask ${index}` }] },
        { id: `a${index}`, type: 'agentMessage', text: `answer ${index}` }
      ]
    }))
    const messages = codexConversationFromThread({ thread: { turns } })!.messages
    expect(messages.at(-1)?.text).toBe('answer 249')
  })

  it('rejects malformed threads and skips malformed items', () => {
    expect(codexConversationFromThread({ thread: { turns: 'invalid' } })).toBeNull()
    expect(codexConversationFromThread(null)).toBeNull()
    expect(
      codexConversationFromThread(thread([null, 'x', { type: 'commandExecution' }]))?.messages
    ).toEqual([])
  })

  it('reads an approval through the shared parser', () => {
    expect(
      parseAgentConversation(
        JSON.stringify({ at: '', messages: [], approval: { id: 7, prompt: 'Run it?' } })
      )?.approval
    ).toBeUndefined()
    expect(
      parseAgentConversation(
        JSON.stringify({ at: '', messages: [], approval: { id: '7', prompt: 'Run it?' } })
      )?.approval
    ).toEqual({ id: '7', prompt: 'Run it?' })
  })
})

describe('Codex conversation adapter', () => {
  it('is the adapter for Codex', () => {
    expect(conversationAdapter('codex')).toBe(codexConversation)
  })

  it('cleans the notes Codex wraps around a prompt', () => {
    expect(
      codexConversation.promptText('<environment_context>cwd</environment_context>Do this')
    ).toBe('Do this')
  })

  it('describes a command whole, its output and its line count', () => {
    expect(
      codexConversation.describeTool({
        id: 'c1',
        tool: 'shell',
        input: { command: 'rg TODO\nsrc' },
        text: 'a\nb'
      })
    ).toEqual({ summary: 'rg TODO\nsrc', result: '2 lines', output: 'a\nb' })
    expect(
      codexConversation.describeTool({
        id: 'c2',
        tool: 'shell',
        input: { command: 'false' },
        text: 'boom\nmore',
        isError: true
      })
    ).toEqual({ summary: 'false', result: 'boom', output: 'boom\nmore' })
  })
})
