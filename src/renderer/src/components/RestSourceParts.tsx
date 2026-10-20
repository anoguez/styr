import { useState, type ReactNode } from 'react'
import type { RestTestResult, SourceSyncState, SyncPreview } from '@core/types.js'
import { ipcMessage } from '../lib/ipcMessage.js'
import { Button, Card, CardRow, Checkbox, Chip, Eyebrow, Hint } from './ui.js'

/** The reply of the last test request: status line, the mapped items, headers and body. */
export function TestResult({ result }: { result: RestTestResult }): ReactNode {
  if (result.error) {
    return (
      <Card>
        <CardRow className="flex flex-col gap-1 px-3.5 py-3">
          <span className="text-[12.5px] font-medium text-danger">Request failed</span>
          <Hint>{result.error}</Hint>
        </CardRow>
      </Card>
    )
  }
  const ok = result.status !== undefined && result.status >= 200 && result.status < 300
  return (
    <Card>
      <CardRow className="flex items-center gap-2 px-3.5 py-2.5 text-[12px]">
        <Chip tone={ok ? 'done' : 'warn'}>
          {result.status} {result.statusText}
        </Chip>
        <span className="text-faint">{result.durationMs} ms</span>
        <span className="flex-1" />
        {ok && result.items ? (
          <span className="text-dim">
            {result.total === 0
              ? 'No items'
              : `${result.total} item${result.total === 1 ? '' : 's'}`}
          </span>
        ) : null}
      </CardRow>

      {ok && result.mappingError ? (
        <CardRow className="px-3.5 py-2.5">
          <Hint>
            <span className="text-danger">Mapping: </span>
            {result.mappingError}
          </Hint>
        </CardRow>
      ) : null}

      {ok && result.items && result.items.length > 0 ? (
        <CardRow className="flex flex-col gap-1.5 px-3.5 py-2.5">
          <Eyebrow>
            {(result.total ?? 0) > result.items.length
              ? `First ${result.items.length} mapped items`
              : 'Mapped items'}
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
        </CardRow>
      ) : null}

      <CardRow className="px-3.5 py-2.5">
        <details className="text-[12px]">
          <summary className="cursor-pointer text-dim hover:text-ink">
            Headers ({result.headers.length})
          </summary>
          <div className="mt-1.5 flex flex-col gap-0.5 font-mono text-[11px]">
            {result.headers.map(([name, value]) => (
              <div key={name} className="flex min-w-0 gap-2">
                <span className="shrink-0 text-dim">{name}:</span>
                <span className="min-w-0 break-all text-ink">{value}</span>
              </div>
            ))}
          </div>
        </details>
      </CardRow>

      <CardRow className="px-3.5 py-2.5">
        <details className="text-[12px]" open={!ok || Boolean(result.mappingError)}>
          <summary className="cursor-pointer text-dim hover:text-ink">
            Body{result.truncated ? ' (cut short)' : ''}
          </summary>
          <pre className="mt-1.5 max-h-[280px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-panel px-2.5 py-2 font-mono text-[11px] text-ink">
            {result.body || '(empty)'}
          </pre>
        </details>
      </CardRow>
    </Card>
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
export function SyncReview({
  sourceId,
  canAct,
  blocked,
  state
}: {
  sourceId: string
  canAct: boolean
  /** Why the source cannot be read yet (unsaved, switched off), or undefined. */
  blocked?: string
  state: SourceSyncState | undefined
}): ReactNode {
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<SyncPreview | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())

  async function review(): Promise<void> {
    setLoading(true)
    try {
      const next = await window.api.sources.preview(sourceId)
      setPreview(next)
      setPicked(new Set(next.entries.map((entry) => entry.itemId)))
    } catch (failure) {
      setPreview({ entries: [], error: ipcMessage(failure) })
    } finally {
      setLoading(false)
    }
  }

  async function apply(): Promise<void> {
    await window.api.sources.apply(sourceId, [...picked])
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
      <CardRow className="flex items-center gap-3 px-3.5 py-3">
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="text-[12.5px] text-ink">Review changes</span>
          <Hint>{blocked ?? lastSync(state)}</Hint>
        </span>
        <Button
          variant="ghost"
          disabled={!canAct || blocked !== undefined || busy}
          title={blocked}
          onClick={() => void review()}
        >
          {loading ? 'Reading…' : preview ? 'Read again' : 'Review changes'}
        </Button>
      </CardRow>

      {preview?.error ? (
        <CardRow className="px-3.5 py-2.5">
          <Hint>
            <span className="text-danger">{preview.error}</span>
          </Hint>
        </CardRow>
      ) : null}
      {preview && !preview.error && entries.length === 0 ? (
        <CardRow className="px-3.5 py-2.5">
          <Hint>Everything is up to date. Nothing to import.</Hint>
        </CardRow>
      ) : null}

      {entries.length > 0 ? (
        <>
          <CardRow className="flex items-center gap-2 px-3.5 py-2">
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
          </CardRow>
          <CardRow className="flex max-h-[320px] flex-col gap-2 overflow-auto px-3.5 py-2.5">
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
          </CardRow>
          <CardRow className="flex items-center justify-end gap-2 px-3.5 py-2.5">
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
          </CardRow>
        </>
      ) : null}
    </>
  )
}
