import { expect, mock, test } from 'claude-code/testing'

const INBOX = '/styr/usage/inbox/t1.jsonl'

test('submits each prompt from Styr’s inbox as the person’s own words', async ($, on) => {
  mock.env(on, { STYR_PROMPT_INBOX: INBOX })
  const clock = mock.clock(on)
  const submitted: { text: string; origin: unknown }[] = []
  let tailed: readonly string[] = []
  on('fs.exists', async () => ({ value: true }))
  on('fs.stat', async () => ({ value: { kind: 'file', size: 12, mtimeMs: 0, isLink: false } }))
  on('fs.write', async () => ({ value: undefined }))
  on('session.messages', async () => ({ value: [] }))
  on('process.spawn', async function* (_$, e) {
    tailed = e.argv
    // A prompt split across two pieces, a line that is not one, and a second prompt.
    yield { stream: 'stdout', text: '{"text":"just\\ntest' }
    yield { stream: 'stdout', text: 'ing"}\nnot json\n{"text":"two"}\n' }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', async (_$, e) => {
    submitted.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  // The inbox is read on its own loop after the session starts; let it run.
  await clock.advance(1000)
  expect(tailed).toEqual(['tail', '-c', '+13', '-F', INBOX])
  expect(submitted.map((prompt) => prompt.text)).toEqual(['just\ntesting', 'two'])
  expect(submitted[0]?.origin).toMatchObject({ asUser: true })
})
