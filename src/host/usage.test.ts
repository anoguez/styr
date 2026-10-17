import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AgentConversation } from '@core/agentConversation.js'
import type { Task } from '@core/types.js'

// `configDir()` is fixed when `core/config.ts` loads, so the home is set before importing.
const home = mkdtempSync(join(tmpdir(), 'styr-usage-'))
process.env.STYR_HOME = home
const { createUsage, MAX_PROMPT_CHARS, sendApprovalAnswer, sendPrompt, watchFiles } =
  await import('./usage.js')

const usageDir = join(home, 'usage')
const app = join(home, 'app')
mkdirSync(join(app, 'resources', 'claude', 'usage-mod'), { recursive: true })

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.STYR_HOME
})

interface Harness {
  sent: { channel: string; payload: unknown }[]
  tasks: Record<string, Task>
  sessions: Record<string, string>
  rollouts: Record<string, string>
  packaged: boolean
  /** The watchers `start` set up, by the folder or file they watch. */
  watchers: Map<string, (path: string) => void>
}

function harness() {
  const h: Harness = {
    sent: [],
    tasks: {},
    sessions: {},
    rollouts: {},
    packaged: false,
    watchers: new Map()
  }
  const usage = createUsage({
    broadcast: (channel, payload) => h.sent.push({ channel, payload }),
    appPaths: {
      get isPackaged() {
        return h.packaged
      },
      version: '1.0.0',
      appPath: app,
      resourcesPath: join(home, 'resources')
    },
    sessionTask: (terminalId) =>
      h.sessions[terminalId] ? { taskId: h.sessions[terminalId] } : undefined,
    findTask: (taskId) => h.tasks[taskId],
    codexTranscript: (threadId) => h.rollouts[threadId],
    watch: (path, _options, onChange) => h.watchers.set(path, onChange)
  })
  return { h, usage }
}

const conversation = (extra: Partial<AgentConversation> = {}): AgentConversation => ({
  at: '2026-01-01T00:00:00Z',
  working: false,
  messages: [],
  ...extra
})

describe('usage', () => {
  it('starts with empty per-terminal folders, clearing a previous run', () => {
    mkdirSync(join(usageDir, 'context'), { recursive: true })
    writeFileSync(join(usageDir, 'context', 'old.json'), '{}')
    harness().usage.start()
    expect(existsSync(join(usageDir, 'context', 'old.json'))).toBe(false)
    for (const dir of ['context', 'conversation', 'inbox'])
      expect(existsSync(join(usageDir, dir))).toBe(true)
  })

  it("points a terminal's Claude Code at the usage mod, ahead of the user's own plugins", () => {
    const { h, usage } = harness()
    const env = usage.usageEnv('/mine', 't1')
    expect(env).toEqual({
      CLAUDE_CODE_PLUGIN_DIRS: `${join(app, 'resources', 'claude', 'usage-mod')}${delimiter}/mine`,
      STYR_USAGE_FILE: join(usageDir, 'claude.json'),
      STYR_CONTEXT_FILE: join(usageDir, 'context', 't1.json'),
      STYR_CONVERSATION_FILE: join(usageDir, 'conversation', 't1.json'),
      STYR_PROMPT_INBOX: join(usageDir, 'inbox', 't1.jsonl')
    })
    // Packaged, the mod is in the resources folder; without one there is nothing to load.
    h.packaged = true
    expect(usage.usageEnv(undefined, 't1')).toEqual({})
  })

  it("reads the account's quota and a terminal's context fill from the mod's files", () => {
    const { usage } = harness()
    expect(usage.claudeUsage()).toBeNull()
    writeFileSync(join(usageDir, 'claude.json'), JSON.stringify({ at: 'now', rateLimits: [] }))
    expect(usage.claudeUsage()).toMatchObject({ windows: [] })
    expect(usage.context('t2')).toBeNull()
    writeFileSync(
      join(usageDir, 'context', 't2.json'),
      JSON.stringify({ context: { percent: 40 } })
    )
    expect(usage.context('t2')).toMatchObject({ percent: 40 })
  })

  it("reads a Codex task session's usage from the tail of its rollout", () => {
    const { h, usage } = harness()
    const rollout = join(home, 'rollout.jsonl')
    writeFileSync(
      rollout,
      `${JSON.stringify({ timestamp: 'now', payload: { type: 'token_count', rate_limits: null } })}\n`
    )
    h.sessions = { t3: 'TASK-1', t4: 'TASK-2' }
    h.tasks = {
      'TASK-1': { agentSession: { provider: 'codex', id: 'thread-1' } } as Task,
      'TASK-2': { agentSession: { provider: 'claude', id: 'c' } } as Task
    }
    expect(usage.codexUsage('t3')).toBeNull()
    h.rollouts['thread-1'] = rollout
    expect(usage.codexUsage('t3')).not.toBeNull()
    expect(usage.codexUsage('t4')).toBeNull()
    expect(usage.codexUsage('shell')).toBeNull()
    rmSync(rollout)
    expect(usage.codexUsage('t3')).toBeNull()
  })

  it('publishes a live conversation and serves it before the file', () => {
    const { h, usage } = harness()
    writeFileSync(
      join(usageDir, 'conversation', 't5.json'),
      JSON.stringify(conversation({ at: 'file' }))
    )
    expect(usage.conversation('t5')?.at).toBe('file')
    usage.publishAgentConversation('t5', conversation({ at: 'live' }))
    expect(h.sent).toEqual([
      {
        channel: 'agent:conversation',
        payload: { terminalId: 't5', conversation: conversation({ at: 'live' }) }
      }
    ])
    expect(usage.conversation('t5')?.at).toBe('live')
    usage.forgetContext('t5')
    expect(usage.conversation('t5')).toBeNull()
  })

  it("sends a prompt through the agent's own channel when it has one", async () => {
    const { usage } = harness()
    const submitted: string[] = []
    usage.publishAgentConversation('t6', conversation(), async (text) => {
      if (text === 'busy') throw new Error('turn running')
      submitted.push(text)
    })
    expect(await usage.prompt('t6', 'hello')).toBe(true)
    expect(await usage.prompt('t6', 'busy')).toBe(false)
    expect(await usage.prompt('t6', '  ')).toBe(false)
    expect(submitted).toEqual(['hello'])
  })

  it('otherwise appends the prompt to the terminal inbox', async () => {
    const { usage } = harness()
    usage.start()
    expect(await usage.prompt('t7', 'hi')).toBe(true)
    expect(readFileSync(join(usageDir, 'inbox', 't7.jsonl'), 'utf8')).toBe('{"text":"hi"}\n')
    expect(sendPrompt('../escape', 'hi')).toBe(false)
    expect(sendPrompt('t7', 'x'.repeat(MAX_PROMPT_CHARS + 1))).toBe(false)
  })

  it("answers an approval through the agent's channel, else through the inbox while it still waits", async () => {
    const { usage } = harness()
    usage.start()
    const answers: string[] = []
    usage.publishAgentConversation(
      't8',
      conversation(),
      undefined,
      async (id, option) => void answers.push(`${id} ${option}`)
    )
    await usage.approval('t8', 'a1', 'allow')
    expect(answers).toEqual(['a1 allow'])

    writeFileSync(
      join(usageDir, 'conversation', 't9.json'),
      JSON.stringify(conversation({ approval: { id: 'a2', prompt: 'Run?' } }))
    )
    await usage.approval('t9', 'a2', 'deny')
    expect(readFileSync(join(usageDir, 'inbox', 't9.jsonl'), 'utf8')).toBe(
      '{"approval":"a2","option":"deny"}\n'
    )
    await expect(usage.approval('t9', 'gone', 'deny')).rejects.toThrow('no longer waiting')
    expect(() => sendApprovalAnswer('../x', 'a2', 'deny')).toThrow('Not an agent terminal.')
  })

  it("pushes each new reading of the mod's files to the renderers", () => {
    const { h, usage } = harness()
    usage.start()
    const changed = (watched: string, file: string): void => h.watchers.get(watched)!(file)
    const claudeFile = join(usageDir, 'claude.json')
    writeFileSync(claudeFile, JSON.stringify({ at: 'later', rateLimits: [] }))
    changed(claudeFile, claudeFile)
    const contextFile = join(usageDir, 'context', 't10.json')
    writeFileSync(contextFile, JSON.stringify({ context: { percent: 5 } }))
    changed(join(usageDir, 'context'), contextFile)
    for (const [id, content] of [
      ['t10', JSON.stringify(conversation())],
      ['t11', 'not json']
    ] as const) {
      const file = join(usageDir, 'conversation', `${id}.json`)
      writeFileSync(file, content)
      changed(join(usageDir, 'conversation'), file)
    }
    expect(h.sent).toEqual([
      { channel: 'usage:claude', payload: expect.objectContaining({ windows: [] }) },
      {
        channel: 'usage:context',
        payload: { terminalId: 't10', context: expect.objectContaining({ percent: 5 }) }
      },
      {
        channel: 'agent:conversation',
        payload: { terminalId: 't10', conversation: conversation() }
      }
    ])
  })
})

describe('watchFiles', () => {
  it('reports a file added under the watched folder', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'styr-watch-'))
    const seen: string[] = []
    watchFiles(folder, { depth: 0 }, (path) => seen.push(path))
    // chokidar is ready once it has scanned the folder; keep writing until it reports one.
    await vi.waitFor(
      () => {
        writeFileSync(join(folder, `${seen.length}-${Date.now()}.json`), '{}')
        expect(seen.length).toBeGreaterThan(0)
      },
      { timeout: 10_000, interval: 200 }
    )
    rmSync(folder, { recursive: true, force: true })
  })
})
