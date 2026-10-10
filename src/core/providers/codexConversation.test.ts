import { describe, expect, it } from 'vitest'
import { agentBlocks } from '../agentConversation.js'
import { conversationAdapter } from './conversation.js'
import { codexConversationFromThread } from './codexConversation.js'

describe('codexConversationFromThread', () => {
  it('maps Codex thread items to bounded neutral messages and tool calls', () => {
    const conversation = codexConversationFromThread({
      thread: {
        updatedAt: 1_800_000_000_000,
        status: { type: 'active' },
        turns: [
          {
            items: [
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
                changes: [{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' }]
              }
            ]
          }
        ]
      }
    })

    expect(conversation).toMatchObject({ working: true, promptInbox: true })
    expect(conversation?.messages).toHaveLength(2)
    expect(conversation?.messages[1]?.toolUses).toEqual([
      { id: 'c1', tool: 'shell', input: { command: 'rg TODO src' }, text: 'src/a.ts: TODO' },
      {
        id: 'f1:0',
        tool: 'apply_patch',
        input: { file_path: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
        text: ''
      }
    ])
    const adapter = conversationAdapter('codex')!
    expect(adapter.describeTool(conversation!.messages[1]!.toolUses[0]!)).toMatchObject({
      summary: 'rg TODO src',
      result: '1 line'
    })
    expect(agentBlocks(conversation!, 'terminal-1', adapter).at(-1)).toMatchObject({
      kind: 'diff',
      payload: { path: 'src/a.ts', additions: 1, deletions: 1 }
    })
    expect(
      agentBlocks(
        {
          ...conversation!,
          approval: { id: 'approval-1', prompt: 'Run this command?', options: ['Allow', 'Deny'] }
        },
        'terminal-1',
        adapter
      ).at(-1)
    ).toMatchObject({ kind: 'approval', state: 'awaiting-input' })
  })

  it('rejects malformed threads and cleans Codex prompt notes', () => {
    expect(codexConversationFromThread({ thread: { turns: 'invalid' } })).toBeNull()
    expect(
      conversationAdapter('codex')?.promptText(
        '<environment_context>cwd</environment_context>Do this'
      )
    ).toBe('Do this')
  })
})
