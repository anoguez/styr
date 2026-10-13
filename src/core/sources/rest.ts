import { contentHash } from './sync.js'
import type {
  RemoteItem,
  RestMapping,
  RestRequest,
  RestSourceSettings,
  RestTestResult,
  SourceAdapter,
  SourceConfig
} from './types.js'

/** Has no repository; every item of the endpoint shares this one target. */
export const REST_TARGET = 'rest'

/** A reply larger than this is cut in the test view; the full reply still maps. */
const TEST_BODY_LIMIT = 64 * 1024
/** How many mapped items the test shows. */
const TEST_PREVIEW = 5
const TIMEOUT_MS = 30_000

export type Fetch = typeof fetch

/**
 * Reads a dot path out of parsed JSON: `data.items`, `fields.summary`, `labels[0].name`. An empty
 * path is the value itself; a missing step is undefined.
 */
export function readPath(value: unknown, path: string): unknown {
  const steps = path
    .trim()
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
  let current = value
  for (const step of steps) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[step]
  }
  return current
}

function text(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function labelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return value === undefined || value === null ? [] : [text(value)]
  return value
    .map((entry) =>
      entry && typeof entry === 'object'
        ? text((entry as Record<string, unknown>).name)
        : text(entry)
    )
    .filter(Boolean)
}

/** Turns a parsed reply into items. Throws with a reason the pane can show. */
export function mapItems(reply: unknown, mapping: RestMapping): RemoteItem[] {
  const list = readPath(reply, mapping.items)
  if (!Array.isArray(list)) {
    throw new Error(
      mapping.items.trim()
        ? `"${mapping.items}" is not an array in the reply.`
        : 'The reply is not an array. Set the items path to the array that holds them.'
    )
  }
  const closed = new Set(mapping.closedValues.map((value) => value.trim().toLowerCase()))
  const items: RemoteItem[] = []
  for (const entry of list) {
    const id = text(readPath(entry, mapping.id))
    if (!id) continue
    const title = text(readPath(entry, mapping.title)) || id
    const body = mapping.body.trim() ? text(readPath(entry, mapping.body)) : ''
    const state = mapping.state.trim() ? text(readPath(entry, mapping.state)) : ''
    const labels = mapping.labels.trim() ? labelsOf(readPath(entry, mapping.labels)) : []
    const updated = mapping.updatedAt.trim() ? text(readPath(entry, mapping.updatedAt)) : ''
    const isClosed = closed.has(state.trim().toLowerCase())
    items.push({
      id,
      url: mapping.url.trim() ? text(readPath(entry, mapping.url)) : '',
      title,
      body,
      state: isClosed ? 'closed' : 'open',
      labels,
      // without a timestamp, a change in what was imported is what counts as an update
      updatedAt: updated || contentHash(`${title}\n${state}\n${labels.join(',')}`, body)
    })
  }
  if (list.length > 0 && items.length === 0)
    throw new Error(`No item has a value at "${mapping.id}", so none has an id.`)
  return items
}

function hasBody(request: RestRequest): boolean {
  return request.method !== 'GET' && request.body.trim() !== ''
}

/** The `fetch` arguments for a request. Throws for a URL that is not http(s). */
export function buildRequest(request: RestRequest): { url: string; init: RequestInit } {
  let url: URL
  try {
    url = new URL(request.url.trim())
  } catch {
    throw new Error('Enter a full URL, starting with https://.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('Only http and https URLs can be requested.')
  const headers = new Headers()
  for (const header of request.headers) {
    if (header.enabled && header.name.trim()) headers.append(header.name.trim(), header.value)
  }
  const body = hasBody(request) ? request.body : undefined
  if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', looksLikeJson(body) ? 'application/json' : 'text/plain')
  }
  if (!headers.has('accept')) headers.set('accept', 'application/json')
  return { url: url.toString(), init: { method: request.method, headers, body } }
}

function looksLikeJson(body: string): boolean {
  try {
    JSON.parse(body)
    return true
  } catch {
    return false
  }
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch {
    return { ok: false }
  }
}

async function send(
  request: RestRequest,
  fetchImpl: Fetch
): Promise<{ response: Response; raw: string; durationMs: number }> {
  const { url, init } = buildRequest(request)
  const started = Date.now()
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const raw = await response.text()
  return { response, raw, durationMs: Date.now() - started }
}

function failure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return `No reply within ${TIMEOUT_MS / 1000} seconds.`
    const cause = (error as Error & { cause?: unknown }).cause
    return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message
  }
  return String(error)
}

/**
 * Sends the request once and reports everything about the reply, for the pane's Test button.
 * Never throws: a request that could not be sent comes back as `error`.
 */
export async function testRestRequest(
  settings: RestSourceSettings,
  fetchImpl: Fetch = fetch
): Promise<RestTestResult> {
  const started = Date.now()
  let sent: Awaited<ReturnType<typeof send>>
  try {
    sent = await send(settings.request, fetchImpl)
  } catch (error) {
    return {
      error: failure(error),
      durationMs: Date.now() - started,
      headers: [],
      body: '',
      truncated: false
    }
  }
  const { response, raw, durationMs } = sent
  const parsed = parseJson(raw)
  const pretty = parsed.ok ? JSON.stringify(parsed.value, null, 2) : raw
  const result: RestTestResult = {
    status: response.status,
    statusText: response.statusText,
    durationMs,
    headers: [...response.headers.entries()],
    body: pretty.slice(0, TEST_BODY_LIMIT),
    truncated: pretty.length > TEST_BODY_LIMIT
  }
  if (!response.ok) return result
  if (!parsed.ok)
    return { ...result, mappingError: 'The reply is not JSON, so it cannot be mapped.' }
  try {
    const items = mapItems(parsed.value, settings.mapping)
    return { ...result, items: items.slice(0, TEST_PREVIEW), total: items.length }
  } catch (error) {
    return { ...result, mappingError: failure(error) }
  }
}

function settingsOf(config: SourceConfig): RestSourceSettings {
  if (!config.rest?.request.url.trim()) throw new Error('The REST source has no URL yet.')
  return config.rest
}

async function fetchItems(config: SourceConfig, fetchImpl: Fetch): Promise<RemoteItem[]> {
  const settings = settingsOf(config)
  let sent: Awaited<ReturnType<typeof send>>
  try {
    sent = await send(settings.request, fetchImpl)
  } catch (error) {
    throw new Error(`Could not reach the REST source: ${failure(error)}`, { cause: error })
  }
  const { response, raw } = sent
  if (!response.ok)
    throw new Error(`The REST source replied ${response.status} ${response.statusText}`.trim())
  const parsed = parseJson(raw)
  if (!parsed.ok) throw new Error('The REST source did not reply with JSON.')
  return mapItems(parsed.value, settings.mapping)
}

/**
 * A REST endpoint that lists items. Read-only: it has no writer, so `writableSource` refuses it.
 * Labels filter like GitHub's; the endpoint is asked again for a single item, since a generic API
 * has no agreed URL for one.
 */
export function makeRestAdapter(fetchImpl: Fetch = (...args) => fetch(...args)): SourceAdapter {
  return {
    provider: 'rest',
    label: 'REST API',
    tagPrefix: 'rest',
    fixedTarget: REST_TARGET,
    status: async () => ({ state: 'ready', version: '' }),
    detectTarget: () => REST_TARGET,

    async list(config, _run, _target, { limit }) {
      const items = (await fetchItems(config, fetchImpl)).filter(
        (item) =>
          (config.includeClosed || item.state === 'open') &&
          config.labels.every((label) => item.labels.includes(label))
      )
      return items.slice(0, limit)
    },

    async get(config, _run, _target, id) {
      const item = (await fetchItems(config, fetchImpl)).find((entry) => entry.id === id)
      if (!item) throw new Error(`Item ${id} was not found in the REST source.`)
      return item
    },

    parseRef(text, defaultTarget) {
      const id = text.trim().replace(/^#/, '')
      return id ? { target: defaultTarget ?? REST_TARGET, id } : null
    }
  }
}

export const restAdapter = makeRestAdapter()
