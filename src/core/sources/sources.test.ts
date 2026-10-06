import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RemoteItem, Settings, SourceConfig, SourceTarget, Task } from '../types.js'
import { SourceReadOnlyError, activeSources, sourceTargets, writableSource } from './index.js'
import {
  checkGh,
  compareVersions,
  detectGithubRepo,
  githubAdapter,
  parseGithubRemote
} from './github.js'
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

const TARGET = 'acme/styr'
const where: SourceTarget = { target: TARGET, repoPath: '/code/styr' }

const source = (over: Partial<SourceConfig> = {}): SourceConfig => ({
  id: 's1',
  provider: 'github',
  access: 'read',
  enabled: true,
  pollMinutes: 5,
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
      target: TARGET,
      remoteUpdatedAt: '2026-01-01T00:00:00Z',
      syncedHash: contentHash('Crash on start', 'It crashes')
    },
    ...over
  }
}

describe('the experimental flag', () => {
  const settings = (externalSources: boolean) =>
    ({ experimental: { externalSources }, sources: [source({ access: 'read_write' })] }) as Settings

  it('leaves no source able to act while off, even a configured read/write one', () => {
    expect(activeSources(settings(false))).toEqual([])
    expect(activeSources(settings(true))).toHaveLength(1)
    const { run } = fakeRunner(() => ok())
    expect(() => writableSource('s1', TARGET, run, () => activeSources(settings(false)))).toThrow(
      /not set up/
    )
  })
})

describe('writableSource', () => {
  it('refuses every read-only source', () => {
    const { run, calls } = fakeRunner(() => ok())
    expect(() => writableSource('s1', TARGET, run, () => [source({ access: 'read' })])).toThrow(
      SourceReadOnlyError
    )
    expect(calls).toEqual([])
  })

  it('refuses a disabled or removed source', () => {
    const { run } = fakeRunner(() => ok())
    const off = [source({ access: 'read_write', enabled: false })]
    expect(() => writableSource('s1', TARGET, run, () => off)).toThrow(SourceReadOnlyError)
    expect(() => writableSource('s1', TARGET, run, () => [])).toThrow(/not set up/)
  })

  it('writes through gh, to the task repository, when read/write', async () => {
    const { run, calls } = fakeRunner(() => ok())
    await writableSource('s1', TARGET, run, () => [source({ access: 'read_write' })]).close('42')
    expect(calls).toEqual([['issue', 'close', '42', '-R', 'acme/styr']])
  })

  it('re-reads access on every call, so a downgrade takes effect at once', () => {
    let current = source({ access: 'read_write' })
    const { run } = fakeRunner(() => ok())
    expect(() => writableSource('s1', TARGET, run, () => [current])).not.toThrow()
    current = { ...current, access: 'read' }
    expect(() => writableSource('s1', TARGET, run, () => [current])).toThrow(SourceReadOnlyError)
  })
})

describe('a full read-only cycle', () => {
  it('issues no mutating gh call', async () => {
    const { run, calls } = fakeRunner(() => ok('[]'))
    const cfg = source()
    await checkGh(run)
    await githubAdapter.list(cfg, run, TARGET, { limit: 10 })
    expect(planSync([], [item()], cfg, 'github', where).created).toBe(1)
    expect(planPush(task(), task({ status: 'done' }), cfg)).toEqual([])
    const verbs = calls.map((args) => args.slice(0, 2).join(' '))
    expect(verbs.every((verb) => /^(--version|auth status|api user|issue list)$/.test(verb))).toBe(
      true
    )
  })
})

describe('checkGh', () => {
  it('reports each state', async () => {
    expect(
      await checkGh(async () => ({ code: 127, stdout: '', stderr: '', notFound: true }))
    ).toEqual({ state: 'missing' })
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

describe('finding the repository', () => {
  it('reads owner/name from https and ssh remotes', () => {
    expect(parseGithubRemote('https://github.com/acme/styr.git')).toBe('acme/styr')
    expect(parseGithubRemote('https://github.com/acme/styr')).toBe('acme/styr')
    expect(parseGithubRemote('https://user@github.com/acme/styr.git')).toBe('acme/styr')
    expect(parseGithubRemote('git@github.com:acme/styr.git')).toBe('acme/styr')
    expect(parseGithubRemote('ssh://git@github.com/acme/styr.git')).toBe('acme/styr')
    expect(parseGithubRemote('git@gitlab.com:acme/styr.git')).toBeNull()
    expect(parseGithubRemote('https://example.com/github.com/acme/styr')).toBeNull()
  })

  it('detects it from a real checkout, and not from a plain folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'styr-detect-'))
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
    )
    try {
      expect(detectGithubRepo(dir)).toBeNull()
      execFileSync('git', ['init', '-q'], { cwd: dir, env })
      expect(detectGithubRepo(dir)).toBeNull()
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Acme/Styr.git'], {
        cwd: dir,
        env
      })
      expect(detectGithubRepo(dir)).toBe('Acme/Styr')
      expect(detectGithubRepo(join(dir, 'missing'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lists each repository once, whichever checkout found it', () => {
    const adapter = {
      ...githubAdapter,
      detectTarget: (path: string) =>
        ({ '/a': 'acme/one', '/a2': 'ACME/one', '/b': 'acme/two', '/c': null })[path] ?? null
    }
    expect(sourceTargets(adapter, ['/a', '/a2', '/b', '/c', ''])).toEqual([
      { target: 'acme/one', repoPath: '/a' },
      { target: 'acme/two', repoPath: '/b' }
    ])
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
    const items = await githubAdapter.list(
      source({ labels: ['bug'], includeClosed: true }),
      run,
      TARGET,
      {
        limit: 5
      }
    )
    expect(items).toEqual([
      { id: '7', url: 'u', title: 'T', body: '', state: 'open', labels: ['bug'], updatedAt: 'x' }
    ])
    expect(calls[0]).toEqual(
      expect.arrayContaining(['-R', TARGET, '--state', 'all', '--label', 'bug', '--limit', '5'])
    )
  })

  it('rejects a malformed repository before running anything', async () => {
    const { run, calls } = fakeRunner(() => ok('[]'))
    await expect(githubAdapter.list(source(), run, 'nope', { limit: 1 })).rejects.toThrow(
      /owner\/name/
    )
    expect(calls).toEqual([])
  })

  it('parses references: a URL names its own repository, #n uses the checkout', () => {
    expect(githubAdapter.parseRef('#12', TARGET)).toEqual({ target: TARGET, id: '12' })
    expect(githubAdapter.parseRef('https://github.com/other/repo/issues/9', TARGET)).toEqual({
      target: 'other/repo',
      id: '9'
    })
    expect(githubAdapter.parseRef('#12', null)).toBeNull()
    expect(githubAdapter.parseRef('hello', TARGET)).toBeNull()
  })
})

describe('planSync', () => {
  const plan = (tasks: Task[], items: RemoteItem[], cfg = source()) =>
    planSync(tasks, items, cfg, 'github', where)

  it('creates a needs-spec backlog task in the repo checkout, and is idempotent', () => {
    expect(plan([], [item()]).actions[0]).toMatchObject({
      kind: 'create',
      draft: {
        status: 'backlog',
        readiness: 'needs_spec',
        tags: ['github:bug'],
        repoPath: '/code/styr',
        externalRef: { target: TARGET, id: '42' }
      }
    })
    expect(plan([task()], [item()])).toMatchObject({ created: 0, unchanged: 1 })
  })

  it('skips closed issues that are not linked unless closed ones are included', () => {
    expect(plan([], [item({ state: 'closed' })]).created).toBe(0)
    expect(
      plan([], [item({ state: 'closed' })], source({ includeClosed: true })).actions[0]
    ).toMatchObject({
      draft: { status: 'done' }
    })
  })

  it('takes remote edits to untouched fields', () => {
    expect(plan([task()], [item({ title: 'New', updatedAt: 'later' })]).actions[0]).toMatchObject({
      kind: 'update',
      patch: { title: 'New' }
    })
  })

  it('keeps a locally edited title and says so', () => {
    const action = plan([task({ title: 'Mine' })], [item({ title: 'New', updatedAt: 'later' })])
      .actions[0]
    expect(action).toMatchObject({ kind: 'update' })
    if (action?.kind !== 'update') throw new Error()
    expect(action.patch.title).toBeUndefined()
    expect(action.note).toMatch(/kept/)
  })

  it('moves a closed issue to Done, except mid-work or archived', () => {
    const closed = item({ state: 'closed', updatedAt: 'later' })
    expect(plan([task()], [closed]).actions[0]).toMatchObject({ patch: { status: 'done' } })
    const busy = plan([task({ status: 'in_progress' })], [closed]).actions[0]
    expect(busy).toMatchObject({ kind: 'update' })
    expect(busy?.kind === 'update' && busy.patch.status).toBeUndefined()
    const archived = plan([task({ archivedAt: 'x' })], [closed]).actions[0]
    expect(archived?.kind === 'update' && archived.patch.status).toBeUndefined()
  })

  it('tells the same issue number in two repositories apart', () => {
    const other = task({
      externalRef: { provider: 'github', id: '42', sourceId: 's1', target: 'acme/other' }
    })
    expect(plan([other], [item()]).created).toBe(1)
    const elsewhere = task({
      externalRef: { provider: 'github', id: '42', sourceId: 's2', target: TARGET }
    })
    expect(plan([elsewhere], [item()]).created).toBe(1)
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
    ).toMatchObject({
      kind: 'reopen'
    })
  })
  it('comments the PR on review', () => {
    expect(
      planPush(task(), task({ status: 'in_review', prUrl: 'http://pr' }), cfg)[0]
    ).toMatchObject({
      kind: 'comment'
    })
    expect(planPush(task(), task({ status: 'in_review' }), cfg)).toEqual([])
  })
  it('does nothing when the options are off or the status is unchanged', () => {
    expect(planPush(task(), task({ status: 'done' }), source({ access: 'read_write' }))).toEqual([])
    expect(planPush(task(), task(), cfg)).toEqual([])
  })
})
