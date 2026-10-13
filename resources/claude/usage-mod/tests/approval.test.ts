import { expect, mock, test, type TestBody } from 'claude-code/testing'

const FILE = '/styr/usage/conversation/t1.json'
const INBOX = '/styr/usage/inbox/t1.jsonl'

const SUGGESTIONS = [
  {
    type: 'addRules' as const,
    rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
    behavior: 'allow' as const,
    destination: 'localSettings' as const
  }
]

type Shown = { id: string; options: { id: string; label: string; kind: string }[] }

/**
 * A session whose inbox is being read, with the conversation file's approvals recorded. Styr's
 * answer is put on the approval's own `tail` once the approval is shown.
 */
async function session(
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  answer?: string
) {
  mock.env(on, { STYR_CONVERSATION_FILE: FILE, STYR_PROMPT_INBOX: INBOX })
  const clock = mock.clock(on)
  const shown: (Shown | undefined)[] = []
  let onShown: (approval: Shown) => void = () => {}
  const visible = new Promise<Shown>((resolve) => (onShown = resolve))
  let release: () => void = () => {}
  const ended = new Promise<void>((resolve) => (release = resolve))
  let spawns = 0
  on('fs.exists', async () => ({ value: true }))
  on('fs.stat', async () => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }))
  on('fs.write', async (_$, e) => {
    if (e.path !== FILE) return { value: undefined }
    const approval = JSON.parse(e.text).approval as Shown | undefined
    shown.push(approval)
    if (approval) onShown(approval)
    return { value: undefined }
  })
  on('session.messages', async () => ({ value: [] }))
  on('process.spawn', async function* () {
    // The first `tail` is the session's prompt reader: it waits until the test ends.
    if (spawns++ === 0) {
      await ended
      return { value: { code: 0, signal: null } }
    }
    const approval = await visible
    if (answer) {
      yield { stream: 'stdout', text: '{"text":"not an answer"}\n' }
      yield { stream: 'stdout', text: `${JSON.stringify({ approval: approval.id, option: answer })}\n` }
    } else await ended
    return { value: { code: 0, signal: null } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  // Beneath the mod: the settings hooks decide nothing, and a turn ends.
  on('classic.PermissionRequest', async () => ({}))
  on('turn.complete', async () => ({ text: '' }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await clock.advance(1000)
  return { shown, visible, release }
}

test('shows a permission request with its real options and answers it as picked', async ($, on) => {
  const { shown, release } = await session($, on, 'always')
  const result = await $.classic.PermissionRequest({
    tool_name: 'Bash',
    tool_input: { command: 'npm test', description: 'Run the tests' },
    permission_suggestions: SUGGESTIONS
  })
  release()
  expect(result.decision).toEqual({ behavior: 'allow', updatedPermissions: SUGGESTIONS })
  const approval = shown.find((value) => value !== undefined)
  expect(approval).toMatchObject({
    prompt: 'Claude wants to use Bash',
    tool: 'Bash',
    input: { command: 'npm test', description: 'Run the tests' },
    options: [
      { id: 'allow', label: 'Yes', kind: 'allow' },
      { id: 'always', label: "Yes, don't ask again for Bash(npm test:*)", kind: 'allow-always' },
      { id: 'deny', label: 'No', kind: 'deny' }
    ]
  })
  // Answered: the file no longer shows it.
  expect(shown.at(-1)).toBeUndefined()
})

test('a No stops the turn, as the dialog’s does', async ($, on) => {
  const { release } = await session($, on, 'deny')
  const result = await $.classic.PermissionRequest({
    tool_name: 'Write',
    tool_input: { file_path: '/a.ts', content: 'x' }
  })
  release()
  expect(result.decision).toMatchObject({ behavior: 'deny', interrupt: true })
})

test('leaves the decision to the dialog once the turn ends without an answer', async ($, on) => {
  const { visible, release } = await session($, on)
  const pending = $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  await visible
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 5, isAborted: false, turnId: 't' })
  const result = await pending
  release()
  expect(result.decision).toBeUndefined()
})
