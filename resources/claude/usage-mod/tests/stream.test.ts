import { expect, mock, test } from 'claude-code/testing'

const FILE = '/styr/usage/conversation/t1.json'

test('streams the reply into the conversation file as it arrives', async ($, on) => {
  mock.env(on, { STYR_CONVERSATION_FILE: FILE })
  const writes: { streaming?: string; working: boolean }[] = []
  on('fs.write', async (_$, e) => {
    if (e.path === FILE) writes.push(JSON.parse(e.text))
    return { value: undefined }
  })
  on('session.messages', async () => ({ value: [] }))
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: 'Hello' }
    yield { kind: 'text', index: 0, text: ', world' }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'Hello, world',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null
    }
  })
  const stream = $.turn.step({ turnId: 'turn1', index: 0, model: 'm', messageCount: 1 })
  const texts: string[] = []
  let step = await stream.next()
  for (; !step.done; step = await stream.next()) {
    if (step.value.kind === 'text') texts.push(step.value.text)
  }
  // The chunks pass through untouched, and so does the result.
  expect(texts).toEqual(['Hello', ', world'])
  expect(step.value.answer).toBe('Hello, world')
  // The first piece is written at once; the next, inside the coalescing window, waits.
  expect(writes[0]).toMatchObject({ working: true, streaming: 'Hello' })
})

test('leaves a subagent’s steps alone', async ($, on) => {
  mock.env(on, { STYR_CONVERSATION_FILE: FILE })
  let writes = 0
  on('fs.write', async () => {
    writes++
    return { value: undefined }
  })
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: 'sub' }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'sub',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null
    }
  })
  const stream = $.turn.step({
    turnId: 'turn1',
    index: 0,
    model: 'm',
    messageCount: 1,
    agentId: 'a1'
  })
  for await (const _chunk of stream) void _chunk
  expect(writes).toBe(0)
})
