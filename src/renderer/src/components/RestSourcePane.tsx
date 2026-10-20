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
  type SourceSyncState
} from '@core/types.js'
import {
  duplicateRestSource,
  isRestSource,
  newRestSource,
  sourceName
} from '@core/sources/restSources.js'
import { ipcMessage } from '../lib/ipcMessage.js'
import { CloseIcon, CopyIcon, PlusIcon, TrashIcon } from './icons.js'
import { SyncReview, TestResult } from './RestSourceParts.js'
import { Button, Card, CardRow, Eyebrow, Field, Hint, Select, Switch, inputBase } from './ui.js'

type PathKey = Exclude<keyof RestMapping, 'closedValues'>

/** The mapping fields, in the order the pane lays them out two to a row. */
const MAPPING_FIELDS: { key: PathKey; label: string; placeholder: string; hint?: string }[] = [
  { key: 'id', label: 'Id', placeholder: 'id', hint: 'Items without one are skipped.' },
  { key: 'title', label: 'Title', placeholder: 'title' },
  { key: 'body', label: 'Description', placeholder: 'body' },
  { key: 'url', label: 'Link', placeholder: 'html_url' },
  { key: 'labels', label: 'Labels', placeholder: 'tags, or labels' },
  {
    key: 'updatedAt',
    label: 'Updated at',
    placeholder: 'Detect from the content',
    hint: 'Leave empty to spot changes from the content.'
  }
]

const ICON_BUTTON =
  'grid size-8 shrink-0 place-items-center rounded-[7px] text-dim transition-colors hover:bg-raised/70 hover:text-ink disabled:pointer-events-none disabled:opacity-35'

const pathInput = `${inputBase} h-8 w-full px-2.5 font-mono text-[12px]`

function commaList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

/** The host of a request URL, for the list; the URL as typed while it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host || url.trim()
  } catch {
    return url.trim()
  }
}

/** One row of the source list: name, and whether it imports and from where. */
function SourceListItem({
  source,
  selected,
  onSelect
}: {
  source: SourceConfig
  selected: boolean
  onSelect: () => void
}): ReactNode {
  const url = source.rest?.request.url ?? ''
  return (
    <button
      type="button"
      aria-current={selected}
      onClick={onSelect}
      className={`flex items-start gap-2 rounded-[7px] border px-[9px] py-[7px] text-left transition-colors ${
        selected ? 'border-edge-strong bg-raised' : 'border-transparent hover:bg-raised/70'
      }`}
    >
      <span
        aria-hidden
        className={`mt-[5px] size-1.5 shrink-0 rounded-full ${source.enabled ? 'bg-col-done' : 'bg-faint'}`}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="w-full truncate text-[12.5px] font-medium text-ink">
          {sourceName(source)}
        </span>
        <span className="w-full truncate text-[11px] text-faint" title={url || undefined}>
          {url.trim() ? hostOf(url) : 'No URL yet'}
        </span>
      </span>
    </button>
  )
}

function HeaderRows({
  headers,
  onChange
}: {
  headers: RestHeader[]
  onChange: (headers: RestHeader[]) => void
}): ReactNode {
  const changeHeader = (index: number, changes: Partial<RestHeader>): void =>
    onChange(headers.map((header, at) => (at === index ? { ...header, ...changes } : header)))

  return (
    <Card>
      {headers.map((header, index) => (
        <CardRow key={index} className="flex items-center gap-2 py-1.5 pl-3 pr-1.5">
          <Switch
            label={`Send header ${header.name || index + 1}`}
            title={header.enabled ? 'Sent' : 'Not sent'}
            checked={header.enabled}
            onChange={(enabled) => changeHeader(index, { enabled })}
          />
          <input
            aria-label="Header name"
            placeholder="Authorization"
            spellCheck={false}
            className={`${inputBase} h-7 w-[150px] shrink-0 px-2 font-mono text-[12px] ${header.enabled ? '' : 'opacity-50'}`}
            value={header.name}
            onChange={(event) => changeHeader(index, { name: event.target.value })}
          />
          <input
            aria-label="Header value"
            placeholder="Bearer …"
            spellCheck={false}
            className={`${inputBase} h-7 min-w-0 flex-1 px-2 font-mono text-[12px] ${header.enabled ? '' : 'opacity-50'}`}
            value={header.value}
            onChange={(event) => changeHeader(index, { value: event.target.value })}
          />
          <button
            type="button"
            aria-label="Remove header"
            title="Remove header"
            className={`${ICON_BUTTON} !size-7`}
            onClick={() => onChange(headers.filter((_, at) => at !== index))}
          >
            <CloseIcon size={12} />
          </button>
        </CardRow>
      ))}
      <CardRow className="px-1.5 py-1.5">
        <Button
          variant="subtle"
          className="!px-2"
          onClick={() => onChange([...headers, { name: '', value: '', enabled: true }])}
        >
          <PlusIcon size={12} />
          Add header
        </Button>
      </CardRow>
    </Card>
  )
}

/** Everything about one REST source: its request, the test, the mapping and the import. */
function RestSourceEditor({
  source,
  saved,
  canAct,
  state,
  onChange,
  onDuplicate,
  onRemove
}: {
  source: SourceConfig
  saved: SourceConfig | undefined
  canAct: boolean
  state: SourceSyncState | undefined
  onChange: (source: SourceConfig) => void
  onDuplicate: () => void
  onRemove: () => void
}): ReactNode {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<RestTestResult | null>(null)

  const rest = source.rest ?? DEFAULT_REST_SETTINGS
  const { request, mapping } = rest
  const hasUrl = request.url.trim() !== ''
  const dirty = JSON.stringify(saved) !== JSON.stringify(source)

  const change = (changes: Partial<SourceConfig>): void => onChange({ ...source, ...changes })
  const changeRequest = (changes: Partial<RestRequest>): void =>
    change({ rest: { ...rest, request: { ...request, ...changes } } })
  const changeMapping = (changes: Partial<RestMapping>): void =>
    change({ rest: { ...rest, mapping: { ...mapping, ...changes } } })

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

  const blocked = !saved
    ? 'Save first, then review.'
    : !saved.enabled
      ? 'Switch the source on and save, then review.'
      : dirty
        ? 'Save first, then review.'
        : undefined

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex items-center gap-1">
        <input
          aria-label="Source name"
          placeholder="REST API"
          className={`${inputBase} mr-1 h-8 min-w-0 flex-1 px-2.5 text-[13px] font-semibold`}
          value={source.name ?? ''}
          onChange={(event) => change({ name: event.target.value })}
          onBlur={() => {
            if (!source.name?.trim()) change({ name: sourceName({ ...source, name: '' }) })
          }}
        />
        <button
          type="button"
          aria-label="Duplicate source"
          title="Duplicate source"
          onClick={onDuplicate}
          className={ICON_BUTTON}
        >
          <CopyIcon size={14} />
        </button>
        <button
          type="button"
          aria-label="Delete source"
          title="Delete source"
          onClick={onRemove}
          className={`${ICON_BUTTON} !text-danger hover:!bg-red-500/10`}
        >
          <TrashIcon size={14} />
        </button>
      </div>

      <Card>
        <CardRow className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3.5 py-3">
          <span className="flex flex-col gap-[3px]">
            <span className="text-[12.5px] text-ink">Import from this API</span>
            <Hint>
              {source.enabled
                ? 'Read-only. Items are imported only after you review them below.'
                : 'Off. You can still edit and test the request.'}
            </Hint>
          </span>
          <Switch
            label="Import from this API"
            checked={source.enabled}
            disabled={!hasUrl && !source.enabled}
            title={hasUrl || source.enabled ? undefined : 'Enter a URL first'}
            onChange={(enabled) => change({ enabled })}
          />
        </CardRow>
      </Card>

      <div className="flex flex-col gap-3">
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
        <Field
          label="Headers"
          hint="Saved as plain text in this workspace's settings file, tokens included. Keep that folder out of shared repositories if a header carries a secret."
        >
          <HeaderRows
            headers={request.headers}
            onChange={(headers) => changeRequest({ headers })}
          />
        </Field>
        {request.method !== 'GET' ? (
          <Field
            label="Body"
            hint="JSON bodies are sent as application/json unless a header says otherwise."
          >
            <textarea
              aria-label="Request body"
              placeholder='{ "query": "…" }'
              spellCheck={false}
              rows={5}
              className={`${inputBase} w-full resize-y px-3 py-2.5 font-mono text-[12px] leading-[1.65]`}
              value={request.body}
              onChange={(event) => changeRequest({ body: event.target.value })}
            />
          </Field>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Eyebrow>Test</Eyebrow>
          <span className="flex-1" />
          <Button
            variant="ghost"
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
            Sends the request as it is now, saved or not, and shows the reply and the items it maps
            to. Nothing is imported.
          </Hint>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <Eyebrow>Field mapping</Eyebrow>
        <Hint>
          Where each task field sits in the JSON reply, as a dot path such as{' '}
          <code className="font-mono">fields.summary</code> or{' '}
          <code className="font-mono">labels[0].name</code>.
        </Hint>
        <Field label="Items" hint="The array that holds the items. Empty means the reply itself.">
          <input
            aria-label="Items path"
            placeholder="data.items"
            spellCheck={false}
            className={pathInput}
            value={mapping.items}
            onChange={(event) => changeMapping({ items: event.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
          {MAPPING_FIELDS.map(({ key, label, placeholder, hint }) => (
            <Field key={key} label={label} hint={hint}>
              <input
                aria-label={`${label} path`}
                placeholder={placeholder}
                spellCheck={false}
                className={pathInput}
                value={mapping[key]}
                onChange={(event) => changeMapping({ [key]: event.target.value })}
              />
            </Field>
          ))}
          <Field label="State" hint="Leave empty and every item is open.">
            <input
              aria-label="State path"
              placeholder="status"
              spellCheck={false}
              className={pathInput}
              value={mapping.state}
              onChange={(event) => changeMapping({ state: event.target.value })}
            />
          </Field>
          <Field label="Closed when" hint="State values, comma-separated, that mean closed.">
            <input
              aria-label="Closed state values"
              placeholder="closed, done"
              spellCheck={false}
              disabled={!mapping.state.trim()}
              className={`${inputBase} h-8 w-full px-2.5 text-[12px] disabled:opacity-50`}
              value={mapping.closedValues.join(', ')}
              onChange={(event) => changeMapping({ closedValues: commaList(event.target.value) })}
            />
          </Field>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Eyebrow>Import</Eyebrow>
        <Field label="Labels" hint="Only items carrying every label are imported.">
          <input
            aria-label="Labels"
            placeholder="All items, or comma-separated labels"
            className={`${inputBase} h-8 w-full px-2.5 text-[12.5px]`}
            value={source.labels.join(', ')}
            onChange={(event) => change({ labels: commaList(event.target.value) })}
          />
        </Field>
        <Card>
          <CardRow className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3.5 py-3">
            <span className="flex flex-col gap-[3px]">
              <span className="text-[12.5px] text-ink">Import closed items</span>
              <Hint>Closed items arrive in Done.</Hint>
            </span>
            <Switch
              label="Import closed items"
              checked={source.includeClosed}
              onChange={(includeClosed) => change({ includeClosed })}
            />
          </CardRow>
          <SyncReview
            key={source.id}
            sourceId={source.id}
            canAct={canAct}
            blocked={blocked}
            state={state}
          />
        </Card>
        <Hint>
          New items become Backlog tasks with the default repo path from General, and stay linked.
          Styr only sends the request above; it never writes anything else to the API.
        </Hint>
      </div>
    </div>
  )
}

/**
 * Settings → REST API: any number of REST sources, listed on the left like Presets. Each is one
 * request whose JSON reply lists items, a mapping from the reply's fields to a task, and a test
 * that sends the request as edited. Every one is read-only; imports are reviewed before they apply.
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
  const [states, setStates] = useState<Record<string, SourceSyncState>>({})
  const rests = sources.filter(isRestSource)
  const [selectedId, setSelectedId] = useState<string | null>(rests[0]?.id ?? null)
  const selected = rests.find((source) => source.id === selectedId) ?? rests[0] ?? null

  useEffect(() => {
    void window.api.sources.state().then(setStates)
    return window.api.sources.onState(setStates)
  }, [])

  function add(source: SourceConfig): void {
    onChange([...sources, source])
    setSelectedId(source.id)
  }

  function update(next: SourceConfig): void {
    onChange(sources.map((item) => (item.id === next.id ? next : item)))
  }

  function remove(source: SourceConfig): void {
    const ok = window.confirm(
      `Delete ${sourceName(source)}?\n\nTasks already imported from it stay on the board, but they no longer sync.`
    )
    if (!ok) return
    const at = rests.findIndex((item) => item.id === source.id)
    onChange(sources.filter((item) => item.id !== source.id))
    const left = rests.filter((item) => item.id !== source.id)
    setSelectedId(left[Math.min(at, left.length - 1)]?.id ?? null)
  }

  return (
    <div className="grid grid-cols-[190px_minmax(0,1fr)] gap-5">
      <div className="flex flex-col gap-0.5">
        {rests.map((source) => (
          <SourceListItem
            key={source.id}
            source={source}
            selected={source.id === selected?.id}
            onSelect={() => setSelectedId(source.id)}
          />
        ))}
        <button
          type="button"
          onClick={() => add(newRestSource(sources))}
          className="mt-1 inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-dashed border-edge-strong px-[9px] text-[12px] font-medium text-dim transition-colors hover:border-faint hover:text-ink"
        >
          <PlusIcon size={14} />
          New REST API
        </button>
      </div>

      {selected ? (
        <RestSourceEditor
          key={selected.id}
          source={selected}
          saved={saved.find((item) => item.id === selected.id)}
          canAct={canAct}
          state={states[selected.id]}
          onChange={update}
          onDuplicate={() => add(duplicateRestSource(sources, selected))}
          onRemove={() => remove(selected)}
        />
      ) : (
        <div className="flex flex-col items-start gap-3 pt-1.5">
          <p className="text-[12.5px] text-dim">
            No REST APIs yet. Add one to import the items an endpoint returns as tasks, after you
            review them.
          </p>
          <Button variant="ghost" onClick={() => add(newRestSource(sources))}>
            <PlusIcon size={12} />
            New REST API
          </Button>
        </div>
      )}
    </div>
  )
}
