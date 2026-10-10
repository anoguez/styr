import { expect, mock, test } from 'claude-code/testing'

const FILE = '/styr/usage/conversation/t1.json'

test('writes the conversation in Styr’s neutral shape when a turn completes', async ($, on) => {
  mock.env(on, { STYR_CONVERSATION_FILE: FILE })
  const written: Record<string, string> = {}
  on('fs.write', async (_$, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('session.messages', async () => ({
    value: [
    { role: 'user', text: 'fix it', toolUses: [] },
    {
      role: 'assistant',
      text: 'Done.',
      toolUses: [
        {
          tool_use_id: 't1',
          tool: 'Edit',
          input: { file_path: '/a.ts', old_string: 'a', new_string: 'b', replace_all: false },
          text: 'Updated'
        }
      ]
    }
    ]
  }))
  on('command.list', async () => ({
    value: [{ name: 'compact', description: 'Clear history but keep a summary', source: 'builtin' }]
  }))
  on('turn.complete', async () => ({ text: 'Done.' }))
  await $.turn.complete({ reason: 'answer', answer: 'Done.', durationMs: 5, isAborted: false, turnId: 'turn1' })
  const file = JSON.parse(written[FILE] ?? '{}')
  expect(file.working).toBe(false)
  expect(file.commands).toEqual([
    { name: 'compact', description: 'Clear history but keep a summary' }
  ])
  expect(file.messages).toEqual([
    { role: 'user', text: 'fix it', toolUses: [] },
    {
      role: 'assistant',
      text: 'Done.',
      toolUses: [
        {
          id: 't1',
          tool: 'Edit',
          input: { file_path: '/a.ts', old_string: 'a', new_string: 'b', replace_all: false },
          text: 'Updated'
        }
      ]
    }
  ])
})
