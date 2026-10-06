import { useState, type ReactNode } from 'react'
import type { Settings, Task } from '@core/types.js'
import { Button, inputBase } from './ui.js'

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
  const enabled = settings.sources.some((source) => source.enabled)

  async function run(action: () => Promise<Task>): Promise<void> {
    setBusy(true)
    setError('')
    try {
      onTask(await action())
      setText('')
    } catch (failure) {
      setError(
        (failure instanceof Error ? failure.message : String(failure)).replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          ''
        )
      )
    } finally {
      setBusy(false)
    }
  }

  if (!ref && !enabled) return null

  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid min-h-8 grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
        <span className="text-[12px] text-dim">Issue</span>
        {ref ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <a
              href={ref.url}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-accent-text)] hover:underline"
            >
              {ref.target ?? ref.provider}#{ref.id}
            </a>
            {ref.sourceId ? (
              <Button
                variant="subtle"
                disabled={busy}
                onClick={() => void run(() => window.api.sources.refresh(task.id))}
              >
                Refresh
              </Button>
            ) : null}
            <Button
              variant="subtle"
              disabled={busy}
              onClick={() => void run(() => window.api.sources.unlink(task.id))}
            >
              Unlink
            </Button>
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
      {error ? <span className="pl-[84px] text-[11.5px] text-danger">{error}</span> : null}
    </div>
  )
}
