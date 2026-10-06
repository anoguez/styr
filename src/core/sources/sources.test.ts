import { describe, expect, it } from 'vitest'
import type { RemoteItem, SourceConfig, Task } from '../types.js'
import { SourceReadOnlyError, writableSource } from './index.js'
import { checkGh, compareVersions, githubAdapter } from './github.js'
import { contentHash, planPush, planSync } from './sync.js'
import type { CommandRunner, RunResult } from './types.js'

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' })

function fakeRunner(reply: (args: string[]) => RunResult) {
  const calls: string[][] = []
  const run: CommandRunner = async (_command, args) => {
    calls.push(args)
    return reply(args)
  }
  return { run, calls }
}

const source = (over: Partial<SourceConfig> = {}): SourceConfig => ({
  id: 's1',
  provider: 'github',
  name: 'styr',
  access: 'read',
  enabled: true,
  pollMinutes: 5,
  repo: 'acme/styr',
  labels: [],
  includeClosed: false,
  mirrorStatus: false,
  commentOnReview: false,
  ...over
})

const item = (over: Partial<RemoteItem> = {}): RemoteItem => ({
  id: '42',
  url: 'https://github.com/acme/styr/issues/42',
  title: 'Crash on start',
  body: 'It crashes',
  state: 'open',
  labels: ['bug'],
  updatedAt: '2026-01-01T00:00:00Z',
  ...over
})

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'TASK-0001',
    title: 'Crash on start',
    status: 'backlog',
    priority: 'medium',
    readiness: 'needs_spec',
    description: 'It crashes',
    activity: [],
    tags: ['github:bug'],
    orchestrate: true,
    useWorktree: false,
    contextFiles: [],
    sessions: [],
    order: 0,
    createdAt: '',
    updatedAt: '',
    filePath: '/x.md',
    format: 'markdown',
    externalRef: {
      provider: 'github',
      id: '42',
      sourceId: 's1',
      remoteUpdatedAt: '2026-01-01T00:00:00Z',
      syncedHash: contentHash('Crash on start', 'It crashes')
    },
    ...over
  }
}

describe('writableSource', () => {
  it('refuses every read-only source', () => {
    const { run, calls } = fakeRunner(() => ok())
    expect(() => writableSource('s1', run, () => [source({ access: 'read' })])).toThrow(
      SourceReadOnlyError
    )
    expect(calls).toEqual([])
  })

  it('refuses a disabled or removed source', () => {
    const { run } = fakeRunner(() => ok())
    expect(() =>
      writableSource('s1', run, () => [source({ access: 'read_write', enabled: false })])
    ).toThrow(SourceReadOnlyError)
    expect(() => writableSource('s1', run, () => [])).toThrow(/no longer exists/)
  })

  it('writes through gh when read/write', async () => {
    const { run, calls } = fakeRunner(() => ok())
    await writableSource('s1', run, () => [source({ access: 'read_write' })]).close('42')
    expect(calls).toEqual([['issue', 'close', '42', '-R', 'acme/styr']])
  })

  it('re-reads access on every call, so a downgrade takes effect at once', () => {
    let current = source({ access: 'read_write' })
    const { run } = fakeRunner(() => ok())
    expect(() => writableSource('s1', run, () => [current])).not.toThrow()
    current = { ...current, access: 'read' }
    expect(() => writableSource('s1', run, () => [current])).toThrow(SourceReadOnlyError)
  })
})

describe('a full read-only cycle', () => {
  it('issues no mutating gh call', async () => {
    const { run, calls } = fakeRunner(() => ok('[]'))
    const cfg = source()
    await githubAdapter.check(cfg, run).catch(() => undefined)
    await githubAdapter.list(cfg, run, { limit: 10 })
    const plan = planSync([], [item()], cfg, 'github')
    expect(plan.created).toBe(1)
    for (const action of planPush(task(), task({ status: 'done' }), cfg))
      expect(action).toBeUndefined()
    const verbs = calls.map((args) => args.slice(0, 2).join(' '))
    expect(
      verbs.every((verb) => /^(--version|auth status|api user|repo view|issue list)$/.test(verb))
    ).toBe(true)
  })
})

describe('checkGh', () => {
  it('reports each state', async () => {
    expect(
      await checkGh(async () => ({ code: 127, stdout: '', stderr: '', notFound: true }))
    ).toEqual({
      state: 'missing'
    })
    expect(await checkGh(async () => ok('gh version 1.9.0 (2020)'))).toMatchObject({
      state: 'outdated'
    })
    const unauth = fakeRunner((args) =>
      args[0] === 'auth' ? { code: 1, stdout: '', stderr: 'no' } : ok('gh version 2.40.1')
    )
    expect(await checkGh(unauth.run)).toEqual({ state: 'unauthenticated', version: '2.40.1' })
    const ready = fakeRunner((args) => (args[0] === 'api' ? ok('octo\n') : ok('gh version 2.40.1')))
    expect(await checkGh(ready.run)).toEqual({ state: 'ready', version: '2.40.1', account: 'octo' })
  })

  it('compares versions numerically', () => {
    expect(compareVersions('2.10.0', '2.9.0')).toBe(1)
    expect(compareVersions('2.0', '2.0.0')).toBe(0)
  })
})

describe('github adapter', () => {
  it('lists issues with filters and maps them', async () => {
    const { run, calls } = fakeRunner(() =>
      ok(
        JSON.stringify([
          {
            number: 7,
            title: 'T',
            body: null,
            state: 'OPEN',
            url: 'u',
            updatedAt: 'x',
            labels: [{ name: 'bug' }]
          }
        ])
      )
    )
    const items = await githubAdapter.list(source({ labels: ['bug'], includeClosed: true }), run, {
      limit: 5
    })
    expect(items).toEqual([
      { id: '7', url: 'u', title: 'T', body: '', state: 'open', labels: ['bug'], updatedAt: 'x' }
    ])
    expect(calls[0]).toEqual(
      expect.arrayContaining(['--state', 'all', '--label', 'bug', '--limit', '5'])
    )
  })

  it('rejects a malformed repo before running anything', async () => {
    const { run, calls } = fakeRunner(() => ok('[]'))
    await expect(githubAdapter.list(source({ repo: 'nope' }), run, { limit: 1 })).rejects.toThrow(
      /owner\/name/
    )
    expect(calls).toEqual([])
  })

  it('parses references', () => {
    const cfg = source()
    expect(githubAdapter.parseRef(cfg, '#12')).toBe('12')
    expect(githubAdapter.parseRef(cfg, 'https://github.com/acme/styr/issues/9')).toBe('9')
    expect(githubAdapter.parseRef(cfg, 'https://github.com/other/repo/issues/9')).toBeNull()
    expect(githubAdapter.parseRef(cfg, 'hello')).toBeNull()
  })
})

describe('planSync', () => {
  it('creates a needs-spec backlog task and is idempotent', () => {
    const first = planSync([], [item()], source(), 'github')
    expect(first.actions[0]).toMatchObject({
      kind: 'create',
      draft: { status: 'backlog', readiness: 'needs_spec', tags: ['github:bug'] }
    })
    const created = task()
    expect(planSync([created], [item()], source(), 'github')).toMatchObject({
      created: 0,
      unchanged: 1
    })
  })

  it('skips closed issues that are not linked unless closed ones are included', () => {
    expect(planSync([], [item({ state: 'closed' })], source(), 'github').created).toBe(0)
    expect(
      planSync([], [item({ state: 'closed' })], source({ includeClosed: true }), 'github')
        .actions[0]
    ).toMatchObject({
      draft: { status: 'done' }
    })
  })

  it('takes remote edits to untouched fields', () => {
    const plan = planSync(
      [task()],
      [item({ title: 'New', updatedAt: 'later' })],
      source(),
      'github'
    )
    expect(plan.actions[0]).toMatchObject({ kind: 'update', patch: { title: 'New' } })
  })

  it('keeps a locally edited title and says so', () => {
    const plan = planSync(
      [task({ title: 'Mine' })],
      [item({ title: 'New', updatedAt: 'later' })],
      source(),
      'github'
    )
    const action = plan.actions[0]
    expect(action).toMatchObject({ kind: 'update' })
    if (action?.kind !== 'update') throw new Error()
    expect(action.patch.title).toBeUndefined()
    expect(action.note).toMatch(/kept/)
  })

  it('moves a closed issue to Done, except mid-work or archived', () => {
    const closed = item({ state: 'closed', updatedAt: 'later' })
    expect(planSync([task()], [closed], source(), 'github').actions[0]).toMatchObject({
      patch: { status: 'done' }
    })
    const busy = planSync([task({ status: 'in_progress' })], [closed], source(), 'github')
      .actions[0]
    expect(busy).toMatchObject({ kind: 'update' })
    expect(busy?.kind === 'update' && busy.patch.status).toBeUndefined()
    const archived = planSync([task({ archivedAt: 'x' })], [closed], source(), 'github').actions[0]
    expect(archived?.kind === 'update' && archived.patch.status).toBeUndefined()
  })

  it('does not link tasks from another source', () => {
    const other = task({ externalRef: { provider: 'github', id: '42', sourceId: 's2' } })
    expect(planSync([other], [item()], source(), 'github').created).toBe(1)
  })
})

describe('planPush', () => {
  const cfg = source({ access: 'read_write', mirrorStatus: true, commentOnReview: true })
  it('closes on Done and reopens when leaving it', () => {
    expect(planPush(task(), task({ status: 'done' }), cfg)[0]).toMatchObject({
      kind: 'close',
      itemId: '42'
    })
    expect(
      planPush(task({ status: 'done' }), task({ status: 'in_progress' }), cfg)[0]
    ).toMatchObject({ kind: 'reopen' })
  })
  it('comments the PR on review', () => {
    expect(
      planPush(task(), task({ status: 'in_review', prUrl: 'http://pr' }), cfg)[0]
    ).toMatchObject({ kind: 'comment' })
    expect(planPush(task(), task({ status: 'in_review' }), cfg)).toEqual([])
  })
  it('does nothing when the options are off or the status is unchanged', () => {
    expect(planPush(task(), task({ status: 'done' }), source({ access: 'read_write' }))).toEqual([])
    expect(planPush(task(), task(), cfg)).toEqual([])
  })
})
