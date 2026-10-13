import { describe, expect, it } from 'vitest'
import { sourceConfigSchema } from '../taskSchema.js'
import type { SourceConfig } from '../types.js'
import { adapterFor, writableSource } from './index.js'
import {
  REST_TARGET,
  buildRequest,
  makeRestAdapter,
  mapItems,
  readPath,
  testRestRequest,
  type Fetch
} from './rest.js'
import { DEFAULT_REST_SETTINGS, type RestSourceSettings } from './types.js'

const settings = (changes: Partial<RestSourceSettings['request']> = {}): RestSourceSettings => ({
  request: { ...DEFAULT_REST_SETTINGS.request, url: 'https://api.test/items', ...changes },
  mapping: DEFAULT_REST_SETTINGS.mapping
})

function source(changes: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: 'rest',
    provider: 'rest',
    access: 'read',
    enabled: true,
    pollMinutes: 0,
    labels: [],
    includeClosed: false,
    mirrorStatus: false,
    commentOnReview: false,
    rest: settings(),
    ...changes
  }
}

function fakeFetch(reply: unknown, init: ResponseInit = { status: 200 }) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl: Fetch = async (url, options) => {
    calls.push({ url: String(url), init: options ?? {} })
    const body = typeof reply === 'string' ? reply : JSON.stringify(reply)
    return new Response(body, { headers: { 'content-type': 'application/json' }, ...init })
  }
  return { fetchImpl, calls }
}

describe('readPath', () => {
  const value = { data: { items: [{ name: 'a' }, { name: 'b' }] } }
  it('follows dots and indexes', () => {
    expect(readPath(value, 'data.items[1].name')).toBe('b')
    expect(readPath(value, 'data.items.0.name')).toBe('a')
  })
  it('is the value itself for an empty path, undefined for a missing step', () => {
    expect(readPath(value, '')).toBe(value)
    expect(readPath(value, 'data.nope.deeper')).toBeUndefined()
  })
})

describe('mapItems', () => {
  const mapping = {
    ...DEFAULT_REST_SETTINGS.mapping,
    items: 'results',
    id: 'key',
    title: 'fields.summary',
    body: 'fields.description',
    url: 'self',
    state: 'fields.status.name',
    closedValues: ['Done'],
    updatedAt: 'fields.updated',
    labels: 'fields.labels'
  }
  const reply = {
    results: [
      {
        key: 'ABC-1',
        self: 'https://x/ABC-1',
        fields: {
          summary: 'First',
          description: 'Body',
          status: { name: 'done' },
          updated: '2026-10-01',
          labels: [{ name: 'bug' }, 'ui']
        }
      },
      { key: 2, fields: { summary: 'Second', status: { name: 'Open' } } },
      { fields: { summary: 'No id' } }
    ]
  }

  it('maps fields by path, closes by value without case, and skips items with no id', () => {
    const items = mapItems(reply, mapping)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      id: 'ABC-1',
      url: 'https://x/ABC-1',
      title: 'First',
      body: 'Body',
      state: 'closed',
      labels: ['bug', 'ui'],
      updatedAt: '2026-10-01'
    })
    expect(items[1]).toMatchObject({ id: '2', state: 'open', body: '', labels: [] })
  })

  it('stands in a content hash for a missing timestamp, so an edit counts as an update', () => {
    const plain = { ...DEFAULT_REST_SETTINGS.mapping }
    const [before] = mapItems([{ id: 1, title: 'A' }], plain)
    const [same] = mapItems([{ id: 1, title: 'A' }], plain)
    const [after] = mapItems([{ id: 1, title: 'B' }], plain)
    expect(before!.updatedAt).toBe(same!.updatedAt)
    expect(before!.updatedAt).not.toBe(after!.updatedAt)
  })

  it('says why when the items path is not an array or nothing has an id', () => {
    expect(() => mapItems({ results: {} }, mapping)).toThrow('"results" is not an array')
    expect(() => mapItems({}, DEFAULT_REST_SETTINGS.mapping)).toThrow('not an array')
    expect(() => mapItems([{ name: 'x' }], DEFAULT_REST_SETTINGS.mapping)).toThrow('none has an id')
  })
})

describe('buildRequest', () => {
  it('sends enabled headers only, and a body only for methods that carry one', () => {
    const { init } = buildRequest(
      settings({
        method: 'POST',
        body: '{"q":1}',
        headers: [
          { name: 'Authorization', value: 'Bearer t', enabled: true },
          { name: 'X-Off', value: '1', enabled: false },
          { name: ' ', value: 'blank', enabled: true }
        ]
      }).request
    )
    const headers = init.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer t')
    expect(headers.has('x-off')).toBe(false)
    expect(headers.get('content-type')).toBe('application/json')
    expect(init.body).toBe('{"q":1}')
    expect(buildRequest(settings({ body: '{"q":1}' }).request).init.body).toBeUndefined()
  })

  it('keeps a content type the user set and refuses non-http URLs', () => {
    const { init } = buildRequest(
      settings({
        method: 'PUT',
        body: 'a=1',
        headers: [{ name: 'Content-Type', value: 'text/x', enabled: true }]
      }).request
    )
    expect((init.headers as Headers).get('content-type')).toBe('text/x')
    expect(() => buildRequest(settings({ url: 'file:///etc/passwd' }).request)).toThrow('http')
    expect(() => buildRequest(settings({ url: 'nope' }).request)).toThrow('full URL')
  })
})

describe('testRestRequest', () => {
  it('reports the reply and a preview of the mapped items', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ id: i, title: `T${i}` }))
    const { fetchImpl, calls } = fakeFetch(items)
    const result = await testRestRequest(settings(), fetchImpl)
    expect(calls[0]!.url).toBe('https://api.test/items')
    expect(result.status).toBe(200)
    expect(result.headers).toContainEqual(['content-type', 'application/json'])
    expect(result.body).toContain('"title": "T0"')
    expect(result.total).toBe(8)
    expect(result.items).toHaveLength(5)
  })

  it('shows an error reply without mapping it, and a non-JSON reply with a mapping error', async () => {
    const denied = await testRestRequest(
      settings(),
      fakeFetch({ message: 'no' }, { status: 401 }).fetchImpl
    )
    expect(denied.status).toBe(401)
    expect(denied.items).toBeUndefined()
    const html = await testRestRequest(settings(), fakeFetch('<html>').fetchImpl)
    expect(html.body).toBe('<html>')
    expect(html.mappingError).toContain('not JSON')
  })

  it('never throws: a request that cannot be sent comes back as an error', async () => {
    const refused: Fetch = async () => {
      throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') })
    }
    const result = await testRestRequest(settings(), refused)
    expect(result.error).toBe('fetch failed: ECONNREFUSED')
    expect((await testRestRequest(settings({ url: '' }), refused)).error).toContain('full URL')
  })
})

describe('REST adapter', () => {
  const reply = [
    { id: 1, title: 'Open', tags: ['a', 'b'] },
    { id: 2, title: 'Shut', status: 'closed', tags: ['a'] }
  ]
  const config = (changes: Partial<SourceConfig> = {}): SourceConfig =>
    source({
      rest: {
        ...settings(),
        mapping: { ...DEFAULT_REST_SETTINGS.mapping, state: 'status', labels: 'tags' }
      },
      ...changes
    })
  const run = async () => ({ code: 0, stdout: '', stderr: '' })

  it('lists open items, filtered by labels, and closed ones only when asked', async () => {
    const adapter = makeRestAdapter(fakeFetch(reply).fetchImpl)
    const ids = async (changes: Partial<SourceConfig>): Promise<string[]> =>
      (await adapter.list(config(changes), run, REST_TARGET, { limit: 10 })).map((item) => item.id)
    expect(await ids({})).toEqual(['1'])
    expect(await ids({ includeClosed: true })).toEqual(['1', '2'])
    expect(await ids({ includeClosed: true, labels: ['b'] })).toEqual(['1'])
  })

  it('finds one item by id, and says not found for one that is gone', async () => {
    const adapter = makeRestAdapter(fakeFetch(reply).fetchImpl)
    expect((await adapter.get(config(), run, REST_TARGET, '2')).title).toBe('Shut')
    await expect(adapter.get(config(), run, REST_TARGET, '9')).rejects.toThrow('not found')
  })

  it('fails a sync on an error reply or a missing URL', async () => {
    const adapter = makeRestAdapter(fakeFetch({}, { status: 500 }).fetchImpl)
    await expect(adapter.list(config(), run, REST_TARGET, { limit: 1 })).rejects.toThrow('500')
    await expect(
      adapter.list(source({ rest: undefined }), run, REST_TARGET, { limit: 1 })
    ).rejects.toThrow('no URL')
  })

  it('has one fixed target, takes any typed id, and is registered but never writable', () => {
    const adapter = adapterFor('rest')!
    expect(adapter.fixedTarget).toBe(REST_TARGET)
    expect(adapter.parseRef('#ABC-1', null)).toEqual({ target: REST_TARGET, id: 'ABC-1' })
    expect(() =>
      writableSource('rest', REST_TARGET, run, () => [source({ access: 'read_write' })])
    ).toThrow('No adapter for rest')
  })
})

describe('REST source settings', () => {
  it('fill in defaults for a hand-edited source', () => {
    const parsed = sourceConfigSchema.parse({
      id: 'rest',
      provider: 'rest',
      rest: { request: { url: 'https://x' }, mapping: {} }
    })
    expect(parsed.rest?.request).toEqual({ method: 'GET', url: 'https://x', headers: [], body: '' })
    expect(parsed.rest?.mapping.id).toBe('id')
  })
})
