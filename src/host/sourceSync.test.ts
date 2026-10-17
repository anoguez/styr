import { describe, expect, it } from 'vitest'
import { shippedSettings } from '@core/config.js'
import type { CliStatus, RemoteItem, SourceAdapter, SourceConfig } from '@core/sources/index.js'
import type { Settings, SourceSyncState, Task, TaskDraft } from '@core/types.js'
import { createSourceSync, NO_REPOSITORIES, type SourceSyncStore } from './sourceSync.js'

const item = (id: string, extra: Partial<RemoteItem> = {}): RemoteItem => ({
  id,
  url: `https://github.com/o/r/issues/${id}`,
  title: `Issue ${id}`,
  body: '',
  state: 'open',
  labels: [],
  updatedAt: '2026-01-01T00:00:00Z',
  ...extra
})

const github = (extra: Partial<SourceConfig> = {}): SourceConfig => ({
  id: 'github',
  provider: 'github',
  access: 'read',
  enabled: true,
  pollMinutes: 5,
  labels: [],
  includeClosed: false,
  mirrorStatus: true,
  commentOnReview: false,
  ...extra
})

interface Harness {
  store: SourceSyncStore
  calls: string[]
  rows: Task[]
  sources: SourceConfig[]
  items: RemoteItem[]
  status: CliStatus
  settings: Settings
  timers: { ms: number; run: () => void; cleared: boolean }[]
  /** Resolves the adapter's next `list`; set to hold a sync open. */
  hold?: Promise<void>
  /** What the `rest` provider's adapter overrides of the GitHub one. */
  rest: Partial<SourceAdapter>
  /** A `list` failure, by target. */
  listError?: string
  /** Makes the writer's calls fail. */
  writeError?: string
}

function harness(): Harness {
  const h = {
    calls: [],
    rows: [
      { id: 'TASK-1', title: 'Mine', status: 'backlog', repoPath: '/repo', tags: [], blockedBy: [] }
    ],
    sources: [github()],
    items: [item('1')],
    status: { state: 'ready', version: '2.0.0' },
    settings: {
      ...shippedSettings(),
      defaultRepoPath: '',
      experimental: { ...shippedSettings().experimental, externalSources: true }
    },
    timers: [],
    rest: { provider: 'rest', fixedTarget: 'api', reviewImports: true }
  } as unknown as Harness
  const adapter: SourceAdapter = {
    provider: 'github',
    label: 'GitHub',
    tagPrefix: 'gh',
    status: async () => h.status,
    detectTarget: (repo) => (repo === '/repo' ? 'o/r' : null),
    list: async (_config, _run, target) => {
      await h.hold
      h.calls.push(`list ${target}`)
      if (h.listError) throw new Error(h.listError)
      return [...h.items]
    },
    get: async (_config, _run, target, id) => {
      h.calls.push(`get ${target}#${id}`)
      const found = h.items.find((candidate) => candidate.id === id)
      if (!found) throw new Error('Could not resolve to an issue')
      return found
    },
    parseRef: (text, own) => {
      const match = /^#?(\d+)$/.exec(text)
      return match && own ? { target: own, id: match[1]! } : null
    }
  }
  const find = (id: string): Task => {
    const task = h.rows.find((row) => row.id === id)
    if (!task) throw new Error(`Task ${id} not found`)
    return task
  }
  h.store = {
    loadSettings: () => h.settings,
    sources: () => h.sources,
    adapterFor: (provider) =>
      provider === 'github' ? adapter : provider === 'rest' ? { ...adapter, ...h.rest } : undefined,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    writableSource: (sourceId, target) => {
      const source = h.sources.find((candidate) => candidate.id === sourceId)
      if (source?.access !== 'read_write') throw new Error('read-only')
      const fail = async (): Promise<void> => {
        if (h.writeError) throw new Error(h.writeError)
      }
      return {
        close: async (id) => (await fail(), void h.calls.push(`close ${target}#${id}`)),
        reopen: async (id) => (await fail(), void h.calls.push(`reopen ${target}#${id}`)),
        comment: async (id) => void h.calls.push(`comment ${target}#${id}`)
      }
    },
    testRestRequest: async () => {
      h.calls.push('restTest')
      return { ok: true } as never
    },
    tasks: {
      list: () => h.rows,
      get: (id) => h.rows.find((row) => row.id === id) ?? null,
      create: (draft: TaskDraft) => {
        const task = { ...draft, id: `TASK-${h.rows.length + 1}`, tags: draft.tags ?? [] } as Task
        h.rows.push(task)
        h.calls.push(`create ${task.id} ${task.title}`)
      },
      update: (id, patch) => {
        if (patch.blockedBy?.includes('CYCLE')) throw new Error('a cycle')
        const task = Object.assign(find(id), patch)
        h.calls.push(`update ${id} ${Object.keys(patch).join(',')}`)
        return task
      },
      addNote: (id, _author, message) => h.calls.push(`note ${id}: ${message}`)
    },
    setInterval: (run, ms) => {
      const timer = { ms, run, cleared: false }
      h.timers.push(timer)
      return timer
    },
    clearInterval: (timer) => void ((timer as Harness['timers'][number]).cleared = true)
  }
  return h
}

function started(h: Harness) {
  const sync = createSourceSync(h.store)
  const states: Record<string, SourceSyncState>[] = []
  let changes = 0
  sync.initSourceSync({ onTasksChanged: () => changes++, onState: (s) => states.push(s) })
  return { sync, states, changes: () => changes }
}

describe('source sync', () => {
  it("imports a source's new items into the board and reports its state", async () => {
    const h = harness()
    const { sync, states, changes } = started(h)
    const result = await sync.syncSource('github')
    expect(result).toMatchObject({ syncing: false, created: 1, updated: 0 })
    expect(result.error).toBeUndefined()
    expect(h.calls).toEqual(['list o/r', 'create TASK-2 Issue 1'])
    expect(h.rows[1]!.externalRef).toMatchObject({ sourceId: 'github', target: 'o/r', id: '1' })
    expect(states.map((s) => s.github!.syncing)).toEqual([true, false])
    expect(sync.sourceStates()).toEqual({ github: result })
    expect(changes()).toBeGreaterThan(0)
  })

  it('answers a second sync of a source with the one in flight', async () => {
    const h = harness()
    let release!: () => void
    h.hold = new Promise((resolve) => (release = resolve))
    const { sync } = started(h)
    const first = sync.syncSource('github')
    expect(await sync.syncSource('github')).toMatchObject({ syncing: true })
    release()
    expect(await first).toMatchObject({ syncing: false, created: 1 })
  })

  it('reports why a sync could not run, without throwing', async () => {
    const h = harness()
    const { sync } = started(h)
    expect((await sync.syncSource('jira')).error).toBe('That integration is not set up.')
    h.status = { state: 'unauthenticated', version: '2.0.0' }
    expect((await sync.syncSource('github')).error).toBe(
      'gh is not logged in. Run `gh auth login`.'
    )
    h.status = { state: 'missing' }
    expect((await sync.previewSource('github')).error).toBe('The GitHub CLI (gh) is not installed.')
    h.status = { state: 'ready', version: '2.0.0' }
    h.rows = []
    expect((await sync.syncSource('github')).error).toBe(NO_REPOSITORIES)
    expect(h.calls).toEqual([])
  })

  it('previews a sync without writing to the board', async () => {
    const h = harness()
    const { sync } = started(h)
    const preview = await sync.previewSource('github')
    expect(preview.entries).toMatchObject([{ itemId: '1', kind: 'create', title: 'Issue 1' }])
    expect(h.calls).toEqual(['list o/r'])
  })

  it('applies only the items picked in a reviewed sync', async () => {
    const h = harness()
    h.items = [item('1'), item('2')]
    const { sync } = started(h)
    expect(await sync.applySource('github', ['2'])).toMatchObject({ created: 1 })
    expect(h.calls).toContain('create TASK-2 Issue 2')
    expect(() => sync.applySource('github', 'all')).toThrow()
  })

  it('notes a linked item the source no longer knows, once', async () => {
    const h = harness()
    h.rows[0]!.externalRef = {
      provider: 'github',
      sourceId: 'github',
      target: 'o/r',
      id: '9',
      url: ''
    }
    h.items = []
    const { sync } = started(h)
    await sync.syncSource('github')
    await sync.syncSource('github')
    expect(h.calls.filter((call) => call.startsWith('note'))).toEqual([
      'note TASK-1: o/r#9 can no longer be found in the source; the link may be stale.'
    ])
  })

  it('links a task to an item it does not already link, and unlinks it', async () => {
    const h = harness()
    h.rows.push({
      id: 'TASK-2',
      title: 'Other',
      status: 'backlog',
      repoPath: '/repo',
      tags: []
    } as never)
    const { sync, changes } = started(h)
    const linked = await sync.linkTask('TASK-1', '#1')
    expect(linked.externalRef).toMatchObject({ sourceId: 'github', target: 'o/r', id: '1' })
    await expect(sync.linkTask('TASK-2', '#1')).rejects.toThrow(
      'o/r#1 is already linked to TASK-1.'
    )
    await expect(sync.linkTask('TASK-2', 'nonsense')).rejects.toThrow(
      'Not an issue of o/r: nonsense'
    )
    expect(sync.unlinkTask('TASK-1').externalRef).toBeUndefined()
    expect(changes()).toBe(2)
  })

  it('refuses to link through a disabled source or to a missing task', async () => {
    const h = harness()
    const { sync } = started(h)
    await expect(sync.linkTask('TASK-9', '#1')).rejects.toThrow('Task TASK-9 not found')
    h.sources = [github({ enabled: false })]
    await expect(sync.linkTask('TASK-1', '#1')).rejects.toThrow('Turn the integration on')
  })

  it("re-reads a linked task's item now", async () => {
    const h = harness()
    h.rows[0]!.externalRef = {
      provider: 'github',
      sourceId: 'github',
      target: 'o/r',
      id: '1',
      url: ''
    }
    const { sync } = started(h)
    const task = await sync.refreshTask('TASK-1')
    expect(task.title).toBe('Issue 1')
    expect(h.calls[0]).toBe('get o/r#1')
    await expect(sync.refreshTask('TASK-9')).rejects.toThrow('not linked')
  })

  it("pushes a linked task's move to Done to a writable source, after a baseline", async () => {
    const h = harness()
    h.sources = [github({ access: 'read_write' })]
    const linked = (status: string) =>
      ({
        ...h.rows[0],
        status,
        externalRef: { provider: 'github', sourceId: 'github', target: 'o/r', id: '1', url: '' }
      }) as Task
    const { sync, changes } = started(h)
    sync.observeTasks([linked('in_review')])
    sync.observeTasks([linked('done')])
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.calls).toEqual(['close o/r#1', 'note TASK-1: Closed o/r#1 on github.'])
    expect(changes()).toBe(1)
  })

  it('does not push to a read-only source, nor after a reset baseline', async () => {
    const h = harness()
    const linked = (status: string) =>
      ({
        ...h.rows[0],
        status,
        externalRef: { provider: 'github', sourceId: 'github', target: 'o/r', id: '1', url: '' }
      }) as Task
    const { sync } = started(h)
    sync.observeTasks([linked('in_review')])
    sync.observeTasks([linked('done')])
    h.sources = [github({ access: 'read_write' })]
    sync.resetSourceObserver()
    sync.observeTasks([linked('in_review')])
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.calls).toEqual([])
  })

  it('polls each enabled source on its own timer, and restarts them', () => {
    const h = harness()
    h.sources = [
      github(),
      github({ id: 'off', enabled: false }),
      github({ id: 'manual', pollMinutes: 0 })
    ]
    const { sync } = started(h)
    sync.restartSourcePolling()
    expect(h.timers.map((timer) => timer.ms)).toEqual([5 * 60_000])
    sync.restartSourcePolling()
    expect(h.timers.map((timer) => timer.cleared)).toEqual([true, false])
    sync.stopSourcePolling()
    expect(h.timers[1]!.cleared).toBe(true)
  })

  it('tests a REST request only with external sources turned on', async () => {
    const h = harness()
    const { sync } = started(h)
    h.settings = {
      ...h.settings,
      experimental: { ...h.settings.experimental, externalSources: false }
    }
    expect(() => sync.testRestSource({})).toThrow('Turn on External sources')
    expect(h.calls).toEqual([])
  })

  it('asks the GitHub adapter for the CLI status', async () => {
    const { sync } = started(harness())
    expect(await sync.ghStatus()).toEqual({ state: 'ready', version: '2.0.0' })
  })

  it('reports an outdated CLI and a source with no adapter', async () => {
    const h = harness()
    h.sources = [github(), github({ id: 'jira', provider: 'jira' })]
    const { sync } = started(h)
    expect((await sync.syncSource('jira')).error).toBe('No adapter for jira.')
    h.status = { state: 'outdated', version: '1.0.0', minimum: '2.0.0' }
    expect((await sync.syncSource('github')).error).toBe('gh 1.0.0 is too old.')
    h.status = { state: 'ready', version: '2.0.0' }
    h.rows = []
    expect((await sync.previewSource('github')).error).toBe(NO_REPOSITORIES)
  })

  it('reads a fixed-target source against the default repo path', () => {
    const h = harness()
    h.sources = [github({ id: 'rest', provider: 'rest' }), github()]
    h.settings = { ...h.settings, defaultRepoPath: '/default' }
    const { sync } = started(h)
    expect(sync.listSourceTargets('rest')).toEqual([{ target: 'api', repoPath: '/default' }])
    expect(sync.listSourceTargets('github')).toEqual([{ target: 'o/r', repoPath: '/repo' }])
  })

  it('reports a target whose listing failed, and keeps the others', async () => {
    const h = harness()
    h.listError = 'rate limited'
    const { sync } = started(h)
    expect(await sync.syncSource('github')).toMatchObject({ error: 'rate limited', created: 0 })
  })

  it('closes a linked task that was closed remotely, and does not push that move back', async () => {
    const h = harness()
    h.sources = [github({ access: 'read_write' })]
    h.rows[0]!.externalRef = {
      provider: 'github',
      sourceId: 'github',
      target: 'o/r',
      id: '1',
      url: '',
      remoteUpdatedAt: 'before'
    }
    h.items = [item('1', { state: 'closed' })]
    const { sync } = started(h)
    sync.observeTasks(h.rows.map((row) => ({ ...row })))
    expect(await sync.syncSource('github')).toMatchObject({ updated: 1 })
    expect(h.rows[0]!.status).toBe('done')
    sync.observeTasks(h.rows.map((row) => ({ ...row })))
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.calls.some((call) => call.startsWith('close'))).toBe(false)
  })

  it("copies the source's blocked-by relations, noting one the board refuses", async () => {
    const h = harness()
    h.rows.push({
      id: 'CYCLE',
      title: 'Blocker',
      status: 'backlog',
      repoPath: '/repo',
      tags: [],
      blockedBy: []
    } as never)
    const ref = (id: string) => ({
      provider: 'github',
      sourceId: 'github',
      target: 'o/r',
      id,
      url: ''
    })
    h.rows[0]!.externalRef = { ...ref('1'), remoteUpdatedAt: '2026-01-01T00:00:00Z' }
    h.rows[1]!.externalRef = { ...ref('2'), remoteUpdatedAt: '2026-01-01T00:00:00Z' }
    h.items = [item('1', { blockedBy: [{ target: 'o/r', id: '2' }] }), item('2')]
    const { sync } = started(h)
    await sync.syncSource('github')
    expect(h.calls.filter((call) => call.startsWith('note'))).toEqual([
      'note TASK-1: Could not copy blocked-by from the source: a cycle'
    ])
  })

  it('closes again the open item of a Done task, on a writable mirrored source', async () => {
    const h = harness()
    h.sources = [github({ access: 'read_write' })]
    h.rows[0]!.status = 'done'
    h.rows[0]!.externalRef = {
      provider: 'github',
      sourceId: 'github',
      target: 'o/r',
      id: '1',
      url: '',
      remoteUpdatedAt: '2026-01-01T00:00:00Z'
    }
    const { sync } = started(h)
    await sync.syncSource('github')
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.calls).toContain('close o/r#1')
    expect(h.calls).toContain('note TASK-1: Closed o/r#1 on github.')
  })

  it('leaves archived links alone, and a linked item that failed for another reason', async () => {
    const h = harness()
    const ref = { provider: 'github', sourceId: 'github', target: 'o/r', url: '' }
    h.rows = [
      { ...h.rows[0]!, externalRef: { ...ref, id: '7' }, archivedAt: '2026-01-01' },
      { ...h.rows[0]!, id: 'TASK-2', externalRef: { ...ref, id: '8' } }
    ]
    h.items = []
    const { sync } = started(h)
    const get = h.store.adapterFor('github')!
    const original = get.get
    get.get = async () => {
      throw new Error('network down')
    }
    await sync.syncSource('github')
    get.get = original
    expect(h.calls.filter((call) => call.startsWith('note'))).toEqual([])
  })

  it('reopens a linked task moved out of Done, and notes a push that failed', async () => {
    const h = harness()
    h.sources = [github({ access: 'read_write' })]
    const linked = (status: string) =>
      ({
        ...h.rows[0],
        status,
        externalRef: { provider: 'github', sourceId: 'github', target: 'o/r', id: '1', url: '' }
      }) as Task
    const { sync } = started(h)
    sync.observeTasks([linked('done')])
    sync.observeTasks([linked('in_progress')])
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.calls).toEqual(['reopen o/r#1', 'note TASK-1: Reopened o/r#1 on github.'])
    h.writeError = 'forbidden'
    sync.observeTasks([linked('done')])
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.calls.at(-1)).toBe('note TASK-1: Could not update the source: forbidden')
    // a move with nothing to push
    sync.observeTasks([linked('in_review')])
  })

  it('never polls a reviewed source, and a poll runs a sync', async () => {
    const h = harness()
    h.sources = [github(), github({ id: 'rest', provider: 'rest' })]
    const { sync } = started(h)
    sync.restartSourcePolling()
    expect(h.timers).toHaveLength(1)
    h.timers[0]!.run()
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.calls).toContain('list o/r')
  })

  it('tests a REST request as edited, with external sources on', async () => {
    const h = harness()
    const { sync } = started(h)
    await sync
      .testRestSource({
        request: { method: 'GET', url: 'https://example.com', headers: [], body: '' },
        mapping: { items: '', id: 'id', title: 'title' }
      })
      .catch(() => {})
    expect(() => sync.testRestSource('nonsense')).toThrow()
  })
})
