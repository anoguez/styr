import { expect, mock, test, type TestBody } from 'claude-code/testing'

const FILE = '/styr/usage/conversation/t1.json'
const INBOX = '/styr/usage/inbox/t1.jsonl'

/** AskUserQuestion's input as Claude Code 2.1.332 hands it to the hook. */
const INPUT = {
  questions: [
    {
      question: 'Which colour?',
      header: 'Colour',
      multiSelect: false,
      options: [
        { label: 'Red', description: 'Select red' },
        { label: 'Green', description: 'Select green' }
      ]
    },
    {
      question: 'Which fruits?',
      header: 'Fruit',
      multiSelect: true,
      options: [
        { label: 'Apple', description: 'Select apple' },
        { label: 'Cherry', description: 'Select cherry' }
      ]
    }
  ]
}

type Written = { approval?: unknown; question?: { id: string; questions: unknown[] } }

/**
 * A session whose inbox is being read, with what the conversation file shows recorded. `lines`
 * are put on the question's own `tail` once it is shown, each given its id.
 */
async function session(
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  lines: ((id: string) => unknown)[] = []
) {
  mock.env(on, { STYR_CONVERSATION_FILE: FILE, STYR_PROMPT_INBOX: INBOX })
  const clock = mock.clock(on)
  const written: Written[] = []
  let onShown: (id: string) => void = () => {}
  const visible = new Promise<string>((resolve) => (onShown = resolve))
  let release: () => void = () => {}
  const ended = new Promise<void>((resolve) => (release = resolve))
  let spawns = 0
  on('fs.exists', async () => ({ value: true }))
  on('fs.stat', async () => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }))
  on('fs.write', async (_$, e) => {
    if (e.path !== FILE) return { value: undefined }
    const value = JSON.parse(e.text) as Written
    written.push(value)
    if (value.question) onShown(value.question.id)
    return { value: undefined }
  })
  on('session.messages', async () => ({ value: [] }))
  on('process.spawn', async function* () {
    if (spawns++ === 0) {
      await ended
      return { value: { code: 0, signal: null } }
    }
    const id = await visible
    if (lines.length > 0) {
      for (const line of lines) yield { stream: 'stdout', text: `${JSON.stringify(line(id))}\n` }
    } else await ended
    return { value: { code: 0, signal: null } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('classic.PermissionRequest', async () => ({}))
  on('turn.complete', async () => ({ text: '' }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await clock.advance(1000)
  return { written, visible, release }
}

const ANSWERS = { 'Which colour?': 'Green', 'Which fruits?': 'Apple, Cherry, kiwi' }

test('shows AskUserQuestion as its questions, never as an approval, and answers with them', async ($, on) => {
  const { written, release } = await session($, on, [
    // Not this question's, missing a question, an empty answer: all passed over.
    () => ({ question: 'q-other', answers: ANSWERS }),
    (id) => ({ question: id, answers: { 'Which colour?': 'Green' } }),
    (id) => ({ question: id, answers: { ...ANSWERS, 'Which fruits?': ' ' } }),
    (id) => ({ question: id, answers: ANSWERS })
  ])
  const result = await $.classic.PermissionRequest({
    tool_name: 'AskUserQuestion',
    tool_input: INPUT
  })
  release()
  expect(result.decision).toEqual({
    behavior: 'allow',
    updatedInput: { ...INPUT, answers: ANSWERS }
  })
  expect(written.some((value) => value.approval !== undefined)).toBe(false)
  expect(written.find((value) => value.question)?.question?.questions).toEqual(INPUT.questions)
  // Answered: the file no longer shows it.
  expect(written.at(-1)?.question).toBeUndefined()
})

test('leaves the picker to the TUI once the turn ends without an answer', async ($, on) => {
  const { visible, release } = await session($, on)
  const pending = $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: INPUT })
  await visible
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 5, isAborted: false, turnId: 't' })
  const result = await pending
  release()
  expect(result.decision).toBeUndefined()
})

test('shows nothing for a question shape the picker would not draw', async ($, on) => {
  const { written, release } = await session($, on)
  const result = await $.classic.PermissionRequest({
    tool_name: 'AskUserQuestion',
    tool_input: { questions: 'Which?' }
  })
  release()
  expect(result.decision).toBeUndefined()
  expect(written.some((value) => value.approval !== undefined || value.question)).toBe(false)
})
