import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REMOTE_LIMITS, remoteBoundsProblem } from '@core/taskSchema.js'
import { BOARD_BROADCASTS, SESSION_BROADCASTS, channelRoute } from './channels.js'
import { remoteSettings, remoteTask } from './remoteFixture.js'
import {
  NOTIFICATION_SCHEMAS,
  NotificationGuard,
  RESPONSE_SCHEMAS,
  RemoteInvalidResponse,
  parseResponse
} from './validation.js'

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

describe('the client’s schemas', () => {
  it('has an answer schema for every call the router sends a server', () => {
    const server = [
      ...source('../../server/serverHost.ts').matchAll(/^\s+'([a-z]+:[A-Za-z]+)': channel\(/gm)
    ]
      .map((m) => m[1]!)
      // Forwarded as they are; the router answers the special ones with its own requests below,
      // and turns `terminal:backlog` into `terminal:attach`.
      .filter((c) => ['active', 'session'].includes(channelRoute(c)) && c !== 'terminal:backlog')
    const own = [
      ...source('./router.ts').matchAll(/request\('([a-z]+:[A-Za-z]+)'/g),
      ...source('./terminals.ts').matchAll(/request\('([a-z]+:[A-Za-z]+)'/g),
      ...source('./workspaces.ts').matchAll(/request\('([a-z]+:[A-Za-z]+)'/g),
      ...source('./settings.ts').matchAll(/request\('([a-z]+:[A-Za-z]+)'/g)
    ].map((m) => m[1]!)
    expect(own.length).toBeGreaterThan(5)
    const missing = [...server, ...own].filter((c) => !(c in RESPONSE_SCHEMAS))
    expect(missing).toEqual([])
  })

  it('has a schema for every notification the router acts on', () => {
    const router = source('./router.ts')
    const handler = router.slice(
      router.indexOf('function onNotification'),
      router.indexOf('// ── Calls')
    )
    const cases = [...handler.matchAll(/case '([a-z]+:[A-Za-z]+)':/g)].map((m) => m[1]!)
    expect(cases).toContain('server:notify')
    const missing = [...cases, ...BOARD_BROADCASTS, ...SESSION_BROADCASTS].filter(
      (c) => !(c in NOTIFICATION_SCHEMAS)
    )
    expect(missing).toEqual([])
  })

  it('passes what a real server sends: a whole task and whole settings', () => {
    const task = remoteTask({
      id: 'TASK-0001',
      title: 'x',
      prUrl: 'https://x',
      sessions: [
        {
          id: 's',
          provider: 'claude',
          startedAt: 'x',
          label: 'R',
          dispatch: 'review',
          sentBack: true
        }
      ]
    })
    expect(parseResponse('devbox', 'tasks:get', task)).toEqual(task)
    const settings = remoteSettings()
    expect(parseResponse('devbox', 'settings:get', settings)).toEqual(settings)
  })

  it('passes a task’s review and refuses one with a hostile comment', () => {
    const comment = {
      id: 'c1',
      path: 'src/a.ts',
      side: 'new',
      line: 3,
      text: 'const a = 1',
      body: 'Rename it',
      createdAt: '2026-10-22T10:00:00.000Z'
    }
    const review = { taskId: 'TASK-0001', pending: [comment] }
    expect(parseResponse('devbox', 'review:get', review)).toEqual(review)
    expect(() =>
      parseResponse('devbox', 'review:get', { ...review, pending: [{ ...comment, line: -1 }] })
    ).toThrow(RemoteInvalidResponse)
    expect(() =>
      parseResponse('devbox', 'review:get', {
        ...review,
        pending: [{ ...comment, path: 'a\u0007b' }]
      })
    ).toThrow(RemoteInvalidResponse)
  })

  it('drops keys a schema does not know', () => {
    const task = { ...remoteTask({ id: 'TASK-0001', title: 'x' }), extra: 'surprise' }
    expect(parseResponse('devbox', 'tasks:get', task)).not.toHaveProperty('extra')
  })

  it('refuses an answer to a call it has no schema for', () => {
    expect(() => parseResponse('devbox', 'tasks:somethingNew', [])).toThrow(RemoteInvalidResponse)
  })
})

describe('remoteBoundsProblem', () => {
  it('passes values within bounds', () => {
    expect(remoteBoundsProblem({ a: [1, 'two', null, { b: true }] })).toBeUndefined()
  })

  it('names what is out of bounds', () => {
    expect(remoteBoundsProblem('x'.repeat(REMOTE_LIMITS.string + 1))).toMatch(/too long/)
    expect(remoteBoundsProblem(new Array(REMOTE_LIMITS.entries + 1).fill(0))).toMatch(/list/)
    let deep: unknown = 0
    for (let i = 0; i < REMOTE_LIMITS.depth + 1; i++) deep = [deep]
    expect(remoteBoundsProblem(deep)).toMatch(/deeply/)
    expect(remoteBoundsProblem(JSON.parse('{"__proto__": 1}'))).toMatch(/forbidden key/)
    expect(remoteBoundsProblem({ constructor: 1 })).toMatch(/forbidden key/)
    expect(remoteBoundsProblem({ ['k'.repeat(REMOTE_LIMITS.short + 1)]: 1 })).toMatch(/key/)
  })
})

describe('NotificationGuard', () => {
  it('hands on a valid payload, drops and logs a bad one once per channel until reset', () => {
    const logged: string[] = []
    const guard = new NotificationGuard('devbox', (message) => logged.push(message))
    expect(guard.check('orchestrate:autoState', [{ on: true, junk: 1 }])).toEqual([{ on: true }])
    expect(guard.check('orchestrate:autoState', ['x'])).toBeUndefined()
    expect(guard.check('orchestrate:autoState', ['y'])).toBeUndefined()
    expect(logged).toHaveLength(1)
    guard.reset()
    guard.check('orchestrate:autoState', ['z'])
    expect(logged).toHaveLength(2)
    expect(guard.check('tasks:changed', ['payload'])).toEqual([])
    expect(guard.check('no:such', [])).toBeUndefined()
  })
})
