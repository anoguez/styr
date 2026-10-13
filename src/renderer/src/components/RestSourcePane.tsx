import { useEffect, useState, type ReactNode } from 'react'
import {
  DEFAULT_REST_SETTINGS,
  REST_METHODS,
  type RestHeader,
  type RestMapping,
  type RestMethod,
  type RestRequest,
  type RestTestResult,
  type SourceConfig,
  type SourceSyncState,
  type SyncPreview
} from '@core/types.js'
import { ipcMessage } from '../lib/ipcMessage.js'
import {
  Button,
  Card,
  CardRow,
  Checkbox,
  Chip,
  Eyebrow,
  Hint,
  Select,
  Switch,
  inputBase
} from './ui.js'

const PROVIDER = 'rest'

const DEFAULT_SOURCE: SourceConfig = {
  id: PROVIDER,
  provider: PROVIDER,
  access: 'read',
  enabled: false,
  // reviewed imports never poll
  pollMinutes: 0,
  labels: [],
  includeClosed: false,
  mirrorStatus: false,
  commentOnReview: false,
  rest: DEFAULT_REST_SETTINGS
}

const MAPPING_FIELDS: { key: Exclude<keyof RestMapping, 'closedValues'>; label: string }[] = [
  { key: 'items', label: 'Items' },
  { key: 'id', label: 'Id' },
  { key: 'title', label: 'Title' },
  { key: 'body', label: 'Description' },
  { key: 'url', label: 'Link' },
  { key: 'state', label: 'State' },
  { key: 'updatedAt', label: 'Updated at' },
  { key: 'labels', label: 'Labels' }
]

const PLACEHOLDERS: Record<(typeof MAPPING_FIELDS)[number]['key'], string> = {
  items: 'The reply itself, or e.g. data.items',
  id: 'id',
  title: 'title',
  body: 'body',
  url: 'html_url',
  state: 'Every item is open',
  updatedAt: 'Detect changes from the content',
  labels: 'tags, or labels'
}

const textInput = `${inputBase} h-7 w-full px-2.5 text-[12px]`

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] items-start gap-2.5">
      <span className="pt-[5px] text-[12px] text-dim">{label}</span>
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </div>
  )
}

function commaList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

/** The reply of the last test request: status line, headers, body and the mapped items. */
function TestResult({ result }: { result: RestTestResult }): ReactNode {
  if (result.error) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-danger">Request failed</span>
        <Hint>{result.error}</Hint>
      </div>
    )
  }
  const ok = result.status !== undefined && result.status >= 200 && result.status < 300
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-center gap-2 text-[12px]">
        <Chip tone={ok ? 'done' : 'warn'}>
          {result.status} {result.statusText}
        </Chip>
        <span className="text-faint">{result.durationMs} ms</span>
      </div>

      {ok ? (
        result.mappingError ? (
          <Hint>
            <span className="text-danger">Mapping: </span>
            {result.mappingError}
          </Hint>
        ) : result.items ? (
          <div className="flex flex-col gap-1">
            <Eyebrow>
              {result.total === 0
                ? 'No items'
                : `${result.total} item${result.total === 1 ? '' : 's'}${
                    (result.total ?? 0) > result.items.length
                      ? `, first ${result.items.length} shown`
                      : ''
                  }`}
            </Eyebrow>
            {result.items.map((item) => (
              <div key={item.id} className="flex min-w-0 items-baseline gap-2 text-[12px]">
                <span className="shrink-0 font-mono text-faint">#{item.id}</span>
                <span className="min-w-0 truncate text-ink" title={item.title}>
                  {item.title}
                </span>
                {item.state === 'closed' ? <Chip>closed</Chip> : null}
                {item.labels.length > 0 ? (
                  <span className="min-w-0 truncate text-faint">{item.labels.join(', ')}</span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null
      ) : null}

      <details className="text-[12px]">
        <summary className="cursor-pointer text-dim">Headers ({result.headers.length})</summary>
        <div className="mt-1.5 flex flex-col gap-0.5 font-mono text-[11px]">
          {result.headers.map(([name, value]) => (
            <div key={name} className="flex min-w-0 gap-2">
              <span className="shrink-0 text-dim">{name}:</span>
              <span className="min-w-0 break-all text-ink">{value}</span>
            </div>
          ))}
        </div>
      </details>

      <div className="flex flex-col gap-1">
        <Eyebrow>Body{result.truncated ? ' (cut short)' : ''}</Eyebrow>
        <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-panel px-2.5 py-2 font-mono text-[11px] text-ink">
          {result.body || '(empty)'}
        </pre>
      </div>
    </div>
  )
}

function lastSync(state: SourceSyncState | undefined): string {
  if (state?.error) return state.error
  if (!state?.lastAt) return 'Nothing imported yet.'
  const at = new Date(state.lastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `Last applied ${at}: ${state.created} new, ${state.updated} updated.`
}

/**
 * Review-first syncing: the source is read and the changes listed with checkboxes, all ticked;
 * only the ticked ones are applied. Nothing is imported on a timer.
 */
function SyncReview({
  canAct,
  dirty,
  state
}: {
  canAct: boolean
  dirty: boolean
  state: SourceSyncState | undefined
}): ReactNode {
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<SyncPreview | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())

  async function review(): Promise<void> {
    setLoading(true)
    try {
      const next = await window.api.sources.preview(PROVIDER)
      setPreview(next)
      setPicked(new Set(next.entries.map((entry) => entry.itemId)))
    } catch (failure) {
      setPreview({ entries: [], error: ipcMessage(failure) })
    } finally {
      setLoading(false)
    }
  }

  async function apply(): Promise<void> {
    await window.api.sources.apply(PROVIDER, [...picked])
    setPreview(null)
  }

  function toggle(itemId: string, on: boolean): void {
    const next = new Set(picked)
    if (on) next.add(itemId)
    else next.delete(itemId)
    setPicked(next)
  }

  const entries = preview?.entries ?? []
  const busy = loading || state?.syncing === true

  return (
    <>
      <div className="flex items-center gap-2">
        <Hint>{dirty ? 'Save first, then review.' : lastSync(state)}</Hint>
        <span className="flex-1" />
        <Button
          variant="subtle"
          disabled={!canAct || dirty || busy}
          title={dirty ? 'Save first, then review' : undefined}
          onClick={() => void review()}
        >
          {loading ? 'Reading…' : preview ? 'Read again' : 'Review changes'}
        </Button>
      </div>

      {preview?.error ? <Hint>{preview.error}</Hint> : null}
      {preview && !preview.error && entries.length === 0 ? (
        <Hint>Everything is up to date. Nothing to import.</Hint>
      ) : null}

      {entries.length > 0 ? (
        <>
          <div className="flex items-center gap-2">
            <Eyebrow>
              {picked.size} of {entries.length} selected
            </Eyebrow>
            <span className="flex-1" />
            <Button
              variant="subtle"
              onClick={() => setPicked(new Set(entries.map((entry) => entry.itemId)))}
            >
              All
            </Button>
            <Button variant="subtle" onClick={() => setPicked(new Set())}>
              None
            </Button>
          </div>
          <div className="flex max-h-[320px] flex-col gap-2 overflow-auto">
            {entries.map((entry) => (
              <div key={entry.itemId} className="flex min-w-0 items-start gap-2">
                <span className="min-w-0 flex-1">
                  <Checkbox
                    checked={picked.has(entry.itemId)}
                    onChange={(on) => toggle(entry.itemId, on)}
                    label={`#${entry.itemId} ${entry.title}`}
                    hint={
                      entry.kind === 'create'
                        ? 'New task in Backlog'
                        : `Updates ${entry.taskId}: ${entry.changes.join(', ')}`
                    }
                  />
                </span>
                <Chip tone={entry.kind === 'create' ? 'accent' : 'neutral'}>
                  {entry.kind === 'create' ? 'New' : 'Update'}
                </Chip>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="subtle" onClick={() => setPreview(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={picked.size === 0 || busy}
              onClick={() => void apply()}
            >
              {state?.syncing ? 'Applying…' : `Apply ${picked.size}`}
            </Button>
          </div>
        </>
      ) : null}
    </>
  )
}

/**
 * The REST API pane of Settings: one request (method, URL, headers, body) whose JSON reply lists
 * items, a mapping from the reply's fields to a task, and a test that sends the request as edited.
 * The source is read-only; Styr never sends anything back to it beyond the request itself.
 */
export function RestSourcePane({
  sources,
  saved,
  canAct,
  onChange
}: {
  sources: SourceConfig[]
  saved: SourceConfig[]
  /** Syncing reads the saved settings of the active workspace, so only that one can act. */
  canAct: boolean
  onChange: (sources: SourceConfig[]) => void
}): ReactNode {
  const [state, setState] = useState<SourceSyncState | undefined>()
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<RestTestResult | null>(null)

  useEffect(() => {
    void window.api.sources.state().then((all) => setState(all[PROVIDER]))
    return window.api.sources.onState((all) => setState(all[PROVIDER]))
  }, [])

  const source = sources.find((item) => item.provider === PROVIDER) ?? DEFAULT_SOURCE
  const rest = source.rest ?? DEFAULT_REST_SETTINGS
  const { request, mapping } = rest
  const savedSource = saved.find((item) => item.provider === PROVIDER)
  const dirty = JSON.stringify(savedSource ?? DEFAULT_SOURCE) !== JSON.stringify(source)
  const hasUrl = request.url.trim() !== ''

  function change(changes: Partial<SourceConfig>): void {
    const next = { ...source, ...changes }
    onChange(
      sources.some((item) => item.provider === PROVIDER)
        ? sources.map((item) => (item.provider === PROVIDER ? next : item))
        : [...sources, next]
    )
  }

  const changeRequest = (changes: Partial<RestRequest>): void =>
    change({ rest: { ...rest, request: { ...request, ...changes } } })
  const changeMapping = (changes: Partial<RestMapping>): void =>
    change({ rest: { ...rest, mapping: { ...mapping, ...changes } } })
  const changeHeader = (index: number, changes: Partial<RestHeader>): void =>
    changeRequest({
      headers: request.headers.map((header, at) =>
        at === index ? { ...header, ...changes } : header
      )
    })

  async function test(): Promise<void> {
    setTesting(true)
    try {
      setResult(await window.api.sources.restTest(rest))
    } catch (failure) {
      setResult({
        error: ipcMessage(failure),
        durationMs: 0,
        headers: [],
        body: '',
        truncated: false
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <Card>
        <CardRow className="flex items-center gap-3 px-3.5 py-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              REST API
              {source.enabled ? <Chip>Read-only</Chip> : null}
            </span>
            <span className="text-[11.5px] text-faint">
              {source.enabled
                ? 'The items the request returns are imported and linked.'
                : 'Off. You can still edit and test the request.'}
            </span>
          </span>
          <Switch
            label="Enable the REST API source"
            checked={source.enabled}
            disabled={!hasUrl && !source.enabled}
            title={hasUrl || source.enabled ? undefined : 'Enter a URL first'}
            onChange={(enabled) => change({ enabled })}
          />
        </CardRow>
      </Card>

      <Card>
        <CardRow className="flex flex-col gap-3 px-3.5 py-3">
          <Eyebrow>Request</Eyebrow>
          <div className="flex items-center gap-2">
            <span className="w-[104px] shrink-0">
              <Select
                aria-label="Method"
                compact
                value={request.method}
                onChange={(event) => changeRequest({ method: event.target.value as RestMethod })}
              >
                {REST_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </Select>
            </span>
            <input
              aria-label="URL"
              placeholder="https://api.example.com/items"
              spellCheck={false}
              className={`${inputBase} h-[30px] min-w-0 flex-1 px-2.5 font-mono text-[12px]`}
              value={request.url}
              onChange={(event) => changeRequest({ url: event.target.value })}
            />
          </div>

          <Row label="Headers">
            {request.headers.map((header, index) => (
              <div key={index} className="flex items-center gap-2">
                <Switch
                  label={`Send header ${header.name || index + 1}`}
                  checked={header.enabled}
                  onChange={(enabled) => changeHeader(index, { enabled })}
                />
                <input
                  aria-label="Header name"
                  placeholder="Authorization"
                  spellCheck={false}
                  className={`${textInput} max-w-[160px] font-mono`}
                  value={header.name}
                  onChange={(event) => changeHeader(index, { name: event.target.value })}
                />
                <input
                  aria-label="Header value"
                  placeholder="Bearer …"
                  spellCheck={false}
                  className={`${textInput} min-w-0 flex-1 font-mono`}
                  value={header.value}
                  onChange={(event) => changeHeader(index, { value: event.target.value })}
                />
                <Button
                  variant="subtle"
                  aria-label="Remove header"
                  onClick={() =>
                    changeRequest({ headers: request.headers.filter((_, at) => at !== index) })
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <span>
              <Button
                variant="subtle"
                onClick={() =>
                  changeRequest({
                    headers: [...request.headers, { name: '', value: '', enabled: true }]
                  })
                }
              >
                Add header
              </Button>
            </span>
            <Hint>
              Saved as plain text in this workspace&apos;s settings file, tokens included. Keep that
              folder out of shared repositories if a header carries a secret.
            </Hint>
          </Row>

          <Row label="Body">
            <textarea
              aria-label="Request body"
              placeholder={
                request.method === 'GET' ? 'GET requests carry no body' : '{ "query": "…" }'
              }
              disabled={request.method === 'GET'}
              spellCheck={false}
              rows={5}
              className={`${inputBase} w-full resize-y px-2.5 py-2 font-mono text-[12px] disabled:opacity-50`}
              value={request.body}
              onChange={(event) => changeRequest({ body: event.target.value })}
            />
            <Hint>JSON bodies are sent as application/json unless a header says otherwise.</Hint>
          </Row>
        </CardRow>

        <CardRow className="flex flex-col gap-3 px-3.5 py-3">
          <div className="flex items-center gap-2">
            <Eyebrow>Response</Eyebrow>
            <span className="flex-1" />
            <Button
              variant="subtle"
              disabled={!hasUrl || testing}
              title={hasUrl ? undefined : 'Enter a URL first'}
              onClick={() => void test()}
            >
              {testing ? 'Sending…' : 'Send test request'}
            </Button>
          </div>
          {result ? (
            <TestResult result={result} />
          ) : (
            <Hint>
              Sends the request as it is now, saved or not, and shows the reply and the items it
              maps to. Nothing is imported.
            </Hint>
          )}
        </CardRow>
      </Card>

      <Card>
        <CardRow className="flex flex-col gap-3 px-3.5 py-3">
          <Eyebrow>Map items</Eyebrow>
          <Hint>
            Where each task field sits in the JSON reply, as a dot path such as{' '}
            <code className="font-mono">fields.summary</code> or{' '}
            <code className="font-mono">labels[0].name</code>. Items is the array that holds them.
          </Hint>
          {MAPPING_FIELDS.map(({ key, label }) => (
            <Row key={key} label={label}>
              <input
                aria-label={`${label} path`}
                placeholder={PLACEHOLDERS[key]}
                spellCheck={false}
                className={`${textInput} max-w-[320px] font-mono`}
                value={mapping[key]}
                onChange={(event) => changeMapping({ [key]: event.target.value })}
              />
            </Row>
          ))}
          <Row label="Closed when">
            <input
              aria-label="Closed state values"
              placeholder="closed, done"
              spellCheck={false}
              disabled={!mapping.state.trim()}
              className={`${textInput} max-w-[320px] disabled:opacity-50`}
              value={mapping.closedValues.join(', ')}
              onChange={(event) => changeMapping({ closedValues: commaList(event.target.value) })}
            />
            <Hint>State values, comma-separated, that mean the item is closed.</Hint>
          </Row>
        </CardRow>
      </Card>

      {source.enabled ? (
        <Card>
          <CardRow className="flex flex-col gap-3 px-3.5 py-3">
            <Row label="Labels">
              <input
                aria-label="Labels"
                placeholder="All items, or comma-separated labels"
                className={`${textInput} max-w-[320px]`}
                value={source.labels.join(', ')}
                onChange={(event) => change({ labels: commaList(event.target.value) })}
              />
              <Hint>Only items carrying every label are imported.</Hint>
            </Row>
            <Row label="Closed items">
              <Switch
                label="Import closed items"
                checked={source.includeClosed}
                onChange={(includeClosed) => change({ includeClosed })}
              />
            </Row>
          </CardRow>
          <CardRow className="flex flex-col gap-2.5 px-3.5 py-3">
            <SyncReview canAct={canAct} dirty={dirty} state={state} />
          </CardRow>
        </Card>
      ) : null}
      <Hint>
        Nothing is imported until you review and apply it. New items become Backlog tasks with the
        default repo path from General, and stay linked. Styr only sends the request above; it never
        writes anything else to the API.
      </Hint>
    </>
  )
}
