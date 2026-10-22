import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { REMOTE_LIMITS } from '@core/taskSchema.js'
import { HELLO, remoteTask, settle } from './remoteFixture.js'
import { AT, setup } from './routerFixture.js'

/**
 * A compromised host (`docs/architecture/remote.md`, Trust boundary): its server answers and
 * pushes malformed, oversized and hostile payloads on every kind of channel. Nothing may throw in
 * the main process, nothing invalid may reach the renderer (`broadcast`) or a local action
 * (`notify`, `updateTray`, `openExternal`), and a call with a bad answer reports an error.
 */

const HUGE = 'x'.repeat(REMOTE_LIMITS.string + 1)
const deep = (levels: number): unknown => {
  let value: unknown = 'bottom'
  for (let i = 0; i < levels; i++) value = { next: value }
  return value
}
const protoKey = (): unknown => JSON.parse('{"__proto__": {"polluted": true}, "id": "TASK-0001"}')

/** Values no channel accepts. */
const HOSTILE: [string, unknown][] = [
  ['a string', 'surprise'],
  ['a number', 42],
  ['an array of junk', [1, 'two', { three: 3 }]],
  ['an oversized string', { title: HUGE }],
  ['an oversized list', Array.from({ length: REMOTE_LIMITS.entries + 1 }, () => 0)],
  ['deep nesting', deep(REMOTE_LIMITS.depth + 2)],
  ['a __proto__ key', protoKey()]
]

/** The board channels a renderer reads and writes, as the router forwards them. */
const BOARD_CALLS: [string, ...unknown[]][] = [
  ['tasks:list', {}],
  ['tasks:get', 'TASK-0001'],
  ['tasks:problems'],
  ['tasks:create', { title: 'x' }],
  ['tasks:update', 'TASK-0001', {}],
  ['tasks:reorder', 'backlog', []],
  ['agents:list'],
  ['git:diffStats'],
  ['git:taskDiff', 'TASK-0001'],
  ['git:filePatch', 'TASK-0001', 'a.ts'],
  ['git:branches', '/srv/repo'],
  ['sources:state'],
  ['sources:preview', 'gh'],
  ['orchestrate:plan'],
  ['orchestrate:run'],
  ['orchestrate:autoState'],
  ['worklog:load', 0, 1],
  ['review:get', 'TASK-0001'],
  ['review:prepare', 'TASK-0001'],
  ['review:requestChanges', 'TASK-0001', ''],
  ['terminal:launchAgent', 'TASK-0001'],
  ['terminal:create', {}],
  ['terminal:previewPrompt', 'TASK-0001'],
  ['terminal:listDirectories', '/srv'],
  ['usage:claude']
]

let warn: MockInstance

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  warn.mockRestore()
})

/** A live remote board on devbox, with what was broadcast so far cleared. */
async function live() {
  const t = setup({ active: 'remote-main' })
  t.router.refresh()
  await t.connectAll()
  t.broadcasts.length = 0
  return t
}

/** Nothing the renderer received holds a hostile value. */
function expectNothingHostile(t: ReturnType<typeof setup>): void {
  const sent = JSON.stringify(t.broadcasts)
  expect(sent).not.toContain('surprise')
  expect(sent).not.toContain('polluted')
  expect(sent).not.toContain('xxxxxxxxxx')
  expect(sent).not.toContain('bottom')
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
}

describe('a hostile server: invoke answers', () => {
  it.each(HOSTILE)('fails every board call answered with %s, and shows nothing', async (_, bad) => {
    const t = await live()
    // A prompt preview is a string: any string within bounds is a valid one.
    const calls = BOARD_CALLS.filter(
      ([c]) => typeof bad !== 'string' || c !== 'terminal:previewPrompt'
    )
    for (const [channel] of calls) t.devbox.server.handlers[channel] = () => bad
    for (const [channel, ...args] of calls) {
      await expect(t.call(channel, ...args), channel).rejects.toThrow(/cannot use/)
    }
    await settle()
    expectNothingHostile(t)
  })

  it('fails the router’s own reads quietly: the list, the summaries, settings, sessions', async () => {
    const t = await live()
    for (const channel of [
      'workspaces:boardSummary',
      'settings:brokenFiles',
      'terminal:list',
      'settings:get'
    ]) {
      t.devbox.server.handlers[channel] = () => ({ junk: HUGE })
    }
    // Each falls back to what this machine knows, as when the host does not answer.
    const invoke = (channel: string, local: unknown) =>
      Promise.resolve(t.router.invoke(channel, [], () => local))
    expect(await invoke('workspaces:boardSummary', {})).toEqual({})
    expect(await t.call('terminal:list')).toEqual([
      { id: 'local-1', title: 'Shell', cwd: '/Users/me' }
    ])
    expect(await invoke('settings:brokenFiles', [])).toEqual([])
    expect((await t.call('settings:get')) as object).not.toHaveProperty('junk')
    expectNothingHostile(t)
  })

  it('bounds a task’s body and activity, and a terminal backlog', async () => {
    const t = await live()
    t.devbox.state.tasks.default = [
      { id: 'TASK-0001', title: 'Big', filePath: '/a', description: 'y'.repeat(2 ** 20 + 1) }
    ] as never
    await expect(t.call('tasks:list', {})).rejects.toThrow(/answer to tasks:list/)
    t.devbox.server.handlers['tasks:get'] = () =>
      remoteTask({
        id: 'TASK-0001',
        title: 'Busy',
        activity: Array.from({ length: REMOTE_LIMITS.activity + 1 }, () => ({
          at: AT,
          author: 'agent',
          message: 'm'
        }))
      })
    await expect(t.call('tasks:get', 'TASK-0001')).rejects.toThrow(/answer to tasks:get/)
    await t.call('terminal:launchAgent', 'TASK-0001')
    t.devbox.state.backlog['s-TASK-0001'] = {
      data: 'z'.repeat(REMOTE_LIMITS.terminalOutput + 1),
      sequence: 1,
      marks: []
    }
    await expect(t.call('terminal:backlog', 's-TASK-0001')).rejects.toThrow(/cannot use/)
    expect(t.router.mirrorBacklog('s-TASK-0001')).toBeUndefined()
  })

  it('refuses more sessions than a host may list', async () => {
    const t = await live()
    t.devbox.state.sessions.push(
      ...Array.from({ length: REMOTE_LIMITS.sessions + 1 }, (_, i) => ({
        id: `s${i}`,
        title: 'x',
        cwd: '/'
      }))
    )
    expect(await t.call('terminal:list')).toEqual([
      { id: 'local-1', title: 'Shell', cwd: '/Users/me' }
    ])
  })

  it('never lets a server claim a session running on this machine', async () => {
    const t = await live()
    t.devbox.server.handlers['terminal:launchAgent'] = () => ({
      id: 'local-1',
      title: 'Agent',
      cwd: '/home/me'
    })
    await expect(t.call('terminal:launchAgent', 'TASK-0001')).rejects.toThrow(/does not own/)
    t.devbox.state.sessions.push({ id: 'local-1', title: 'Spoof', cwd: '/' })
    const listed = (await t.call('terminal:list')) as { id: string; host?: string }[]
    expect(listed).toEqual([{ id: 'local-1', title: 'Shell', cwd: '/Users/me' }])
    // Its writes still go to the local PTY.
    const sent: string[] = []
    t.router.send('terminal:write', ['local-1', 'ls\r'], () => sent.push('local'))
    expect(sent).toEqual(['local'])
  })

  it('refuses an answer with a session id that is not one', async () => {
    const t = await live()
    t.devbox.server.handlers['terminal:launchAgent'] = () => ({
      id: '../../etc\npasswd',
      title: 'Agent',
      cwd: '/home/me'
    })
    await expect(t.call('terminal:launchAgent', 'TASK-0001')).rejects.toThrow(/Not a session id/)
  })
})

describe('a hostile server: notifications', () => {
  it.each(HOSTILE)('drops broadcasts carrying %s, logging once per channel', async (_, bad) => {
    const t = await live()
    for (const channel of [
      'agents:changed',
      'orchestrate:autoState',
      'orchestrate:autoStarted',
      'sources:state',
      'usage:claude',
      'terminal:runtimeState',
      'usage:context',
      'agent:conversation',
      'workspaces:activity',
      'settings:changed'
    ]) {
      t.devbox.server.push(channel, bad)
      t.devbox.server.push(channel, bad)
    }
    await settle()
    expect(t.broadcasts).toEqual([])
    expectNothingHostile(t)
    const logged = warn.mock.calls.map(([message]) => String(message))
    expect(logged.filter((m) => m.includes('agents:changed'))).toHaveLength(1)
    expect(logged.every((m) => m.length < 600)).toBe(true)
  })

  it('logs a failing channel again after a reconnect', async () => {
    const t = await live()
    t.devbox.server.push('agents:changed', 'surprise')
    t.devbox.server.drop()
    t.clock.advance(1000)
    t.devbox.server.hello()
    await settle()
    t.devbox.server.push('agents:changed', 'surprise')
    expect(warn.mock.calls.filter(([m]) => String(m).includes('agents:changed'))).toHaveLength(2)
  })

  it('drops a payload on a channel that carries none, and methods it does not know', async () => {
    const t = await live()
    t.devbox.server.push('tasks:changed', { junk: 'surprise' })
    t.devbox.server.push('updates:state', { status: 'surprise' })
    t.devbox.server.push('terminal:nativeFrame', { id: 'local-1' })
    expect(t.broadcasts).toEqual([['tasks:changed', undefined]])
  })

  it('never speaks for a local session or another host’s', async () => {
    const t = await live()
    await t.call('terminal:launchAgent', 'TASK-0001')
    await t.call('terminal:backlog', 's-TASK-0001')
    t.broadcasts.length = 0
    // `vm` names devbox’s session and the local tab.
    for (const id of ['local-1', 's-TASK-0001']) {
      t.vm.server.push('terminal:data', { id, data: 'surprise', sequence: 99, marks: [] })
      t.vm.server.push('terminal:exit', { id, exitCode: 0 })
      t.vm.server.push('terminal:runtimeState', { sessionId: id, cwd: '/', promptReady: true })
      t.vm.server.push('usage:context', { terminalId: id, context: { percent: 1 } })
    }
    t.devbox.server.push('terminal:data', {
      id: 'local-1',
      data: 'surprise',
      sequence: 1,
      marks: []
    })
    t.devbox.server.push('terminal:exit', { id: 'local-1', exitCode: 0 })
    expect(t.broadcasts).toEqual([])
    expect(t.router.isRemoteSession('local-1')).toBe(false)
  })

  it('drops terminal data for a terminal this client never attached', async () => {
    const t = await live()
    t.devbox.server.push('terminal:data', { id: 'other', data: 'surprise', sequence: 1, marks: [] })
    expect(t.broadcasts).toEqual([])
  })

  it('drops an oversized chunk, or one whose marks fall outside it', async () => {
    const t = await live()
    await t.call('terminal:launchAgent', 'TASK-0001')
    await t.call('terminal:backlog', 's-TASK-0001')
    t.broadcasts.length = 0
    const chunk = { id: 's-TASK-0001', sequence: 1, marks: [] }
    t.devbox.server.push('terminal:data', {
      ...chunk,
      data: 'x'.repeat(REMOTE_LIMITS.terminalOutput + 1)
    })
    t.devbox.server.push('terminal:data', {
      ...chunk,
      data: 'ok',
      marks: [{ offset: 99, kind: 'start', id: 'c1', at: 1 }]
    })
    t.devbox.server.push('terminal:data', { ...chunk, data: 'fine', sequence: 2 })
    expect(t.broadcasts).toEqual([
      ['terminal:data', { id: 's-TASK-0001', data: 'fine', sequence: 2, marks: [] }]
    ])
  })

  it('keeps the tray as it was when the tray model is malformed', async () => {
    const t = await live()
    const before = t.trays.length
    t.devbox.server.push('server:tray', { statuses: 'surprise', titles: {} })
    t.devbox.server.push('server:tray', {
      statuses: [{ taskId: 'TASK-0001', state: 'hacked', at: AT, workspaceId: 'default' }]
    })
    t.devbox.server.push('server:tray', { statuses: [], titles: { k: HUGE } })
    expect(t.trays).toHaveLength(before)
  })

  it('shows a notification’s text without controls, cut to length, and drops a malformed one', async () => {
    const t = await live()
    t.devbox.server.push('server:notify', {
      title: 'Paused\u0007\u202e\nnow',
      body: `${'b'.repeat(REMOTE_LIMITS.notifyBody + 50)}\u001b[31m`
    })
    t.devbox.server.push('server:notify', { title: 42 })
    t.devbox.server.push('server:notify', 'surprise')
    expect(t.notified).toHaveLength(1)
    const [title, body] = t.notified[0]!.split(': ')
    expect(title).toBe('Paused now')
    expect(body!.startsWith('devbox · bbb')).toBe(true)
    expect(body!.length).toBeLessThanOrEqual('devbox · '.length + REMOTE_LIMITS.notifyBody)
    // eslint-disable-next-line no-control-regex
    expect(t.notified[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/)
  })
})

describe('a hostile server: the hello', () => {
  it('treats a malformed hello as an incompatible server: nothing is sent to it', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    t.devbox.server.hello({ ...HELLO, version: HUGE } as never)
    t.vm.server.hello({ protocol: 'one' } as never)
    await settle()
    expect(t.router.state().hosts.map((host) => host.status)).toEqual([
      'incompatible',
      'incompatible'
    ])
    expect(t.devbox.server.calls).toEqual([])
    expect(t.vm.server.calls).toEqual([])
    expect(JSON.stringify(t.router.state())).not.toContain('xxxxxxxxxx')
  })
})

describe('a hostile server: the task file link', () => {
  const PATHS = [
    'javascript:alert(1)',
    'file:///etc/passwd',
    '../../../../etc/passwd',
    '/home/me/../../../root/.ssh/id_rsa',
    '/a/b?windowId=_blank#frag',
    '//evil.example/x',
    'C:\\Windows\\System32\\calc.exe',
    '/%2e%2e/%2e%2e/etc',
    '/home/me/Styr/tasks/TASK-0001 a.md',
    'https://evil.example/',
    '/x/\u202e\u0000y'
  ]

  it.each(PATHS)('opens %j only as a VS Code Remote link on the host', async (filePath) => {
    const t = await live()
    t.devbox.server.handlers['tasks:get'] = () =>
      remoteTask({ id: 'TASK-0001', title: 'x', filePath })
    await t.call('tasks:openInEditor', 'TASK-0001').catch(() => undefined)
    for (const url of t.opened) {
      expect(url).toMatch(/^vscode:\/\/vscode-remote\/ssh-remote\+devbox\/[^?#\s\\]*$/)
      expect(url.split('/').slice(4)).not.toContain('..')
    }
  })

  it('refuses a path with control characters before it reaches the link', async () => {
    const t = await live()
    t.devbox.server.handlers['tasks:get'] = () =>
      remoteTask({ id: 'TASK-0001', title: 'x', filePath: '/a\nb' })
    await expect(t.call('tasks:openInEditor', 'TASK-0001')).rejects.toThrow(/control characters/)
    expect(t.opened).toEqual([])
  })
})
