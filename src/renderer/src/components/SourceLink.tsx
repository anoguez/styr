import { useState, type ReactNode } from 'react'
import { ipcMessage } from '../lib/ipcMessage.js'
import type { Settings, Task } from '@core/types.js'
import { RefreshIcon, UnlinkIcon } from './icons.js'
import { Button, inputBase } from './ui.js'

const ICON_BTN =
  'inline-flex size-[22px] shrink-0 items-center justify-center rounded-[5px] text-faint hover:bg-raised/70 hover:text-ink disabled:opacity-40'

/**
 * The task dialog's link to an external item. Linking reads the source and never writes to it, so
 * it works for read-only sources too; the remote is only ever changed by the sync rules.
 */
export function SourceLink({
  task,
  settings,
  onTask
}: {
  task: Task
  settings: Settings
  onTask: (task: Task) => void
}): ReactNode {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = task.externalRef
  // the Issue row links GitHub issues; a REST source's items only arrive by sync
  const enabled =
    settings.experimental.externalSources &&
    settings.sources.some((source) => source.id === 'github' && source.enabled)

  async function run(action: () => Promise<Task>): Promise<void> {
    setBusy(true)
    setError('')
    try {
      onTask(await action())
      setText('')
    } catch (failure) {
      setError(ipcMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  if (!settings.experimental.externalSources || (!ref && !enabled)) return null

  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid min-h-8 grid-cols-[84px_minmax(0,1fr)] items-center gap-2">
        <span className="text-[12px] text-dim">Issue</span>
        {ref ? (
          <div className="flex min-w-0 items-center gap-1 pl-2">
            <a
              href={ref.url}
              target="_blank"
              rel="noreferrer"
              title={
                ref.remoteUpdatedAt
                  ? `Remote last updated ${new Date(ref.remoteUpdatedAt).toLocaleString()}`
                  : ref.url
              }
              className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-accent-text)] hover:underline"
            >
              {ref.target ?? ref.provider}#{ref.id}
            </a>
            {ref.sourceId ? (
              <button
                type="button"
                aria-label="Refresh from remote"
                title="Refresh from remote"
                disabled={busy}
                className={ICON_BTN}
                onClick={() => void run(() => window.api.sources.refresh(task.id))}
              >
                <RefreshIcon size={12} />
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Unlink issue"
              title="Unlink issue"
              disabled={busy}
              className={ICON_BTN}
              onClick={() => void run(() => window.api.sources.unlink(task.id))}
            >
              <UnlinkIcon size={12} />
            </button>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">
            <input
              aria-label="Issue number or URL"
              value={text}
              placeholder="#12 or issue URL"
              onChange={(event) => setText(event.target.value)}
              className={`${inputBase} h-7 min-w-0 flex-1 px-2 text-[12.5px]`}
            />
            <Button
              variant="subtle"
              disabled={busy || !text.trim()}
              onClick={() => void run(() => window.api.sources.link(task.id, text))}
            >
              Link
            </Button>
          </div>
        )}
      </div>
      {error ? <span className="pl-[92px] text-[11.5px] text-danger">{error}</span> : null}
    </div>
  )
}
