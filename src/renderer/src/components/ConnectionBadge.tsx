import type { ReactNode } from 'react'
import { connectionLabel, retryIn, type BoardAccess } from '../lib/remoteStatus.js'

const ACTION =
  'rounded px-1.5 font-medium text-ink underline-offset-2 hover:bg-raised hover:underline'

/**
 * The status bar's connection badge for a remote workspace: connected, or reconnecting with the
 * last error and Retry now, or the server showing another workspace with Switch back. Nothing for
 * a local workspace.
 */
export function ConnectionBadge({
  access,
  workspaceId
}: {
  access: BoardAccess
  workspaceId: string
}): ReactNode {
  const { remote, host } = access
  if (!remote) return null

  if (!access.reason && host?.status === 'connected') {
    return (
      <span
        className="flex items-center gap-1.5 px-2.5 text-[11px] text-dim"
        title={`Connected to ${remote.host}${host.serverVersion ? ` (Styr ${host.serverVersion})` : ''}. This board lives there.`}
      >
        <span aria-hidden className="size-[6px] rounded-full bg-[var(--color-col-done)]" />
        {remote.host}
      </span>
    )
  }

  const tone = remote.error ? 'text-danger' : 'text-[var(--color-col-review)]'
  const seconds = retryIn(host, Date.now())
  const title = [
    access.reason,
    host?.lastError ? `Last error: ${host.lastError}` : '',
    seconds !== undefined ? `Next attempt in about ${seconds}s.` : ''
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <span className={`flex min-w-0 items-center gap-1.5 px-2.5 text-[11px] ${tone}`} title={title}>
      <span aria-hidden className="size-[6px] shrink-0 rounded-full bg-current" />
      <span className="truncate">
        {remote.elsewhere && host?.status === 'connected'
          ? `${remote.host} is showing “${remote.elsewhere}”`
          : remote.error
            ? `${remote.host}: ${remote.error}`
            : host
              ? `${connectionLabel(host)}${host.lastError && host.status !== 'connecting' ? ` — ${host.lastError}` : ''}`
              : 'Remote workspaces are off'}
      </span>
      {remote.elsewhere && host?.status === 'connected' ? (
        <button
          type="button"
          className={ACTION}
          onClick={() => void window.api.remote.switchBack(workspaceId)}
        >
          Switch back
        </button>
      ) : host && host.status !== 'connected' && host.status !== 'connecting' ? (
        <button
          type="button"
          className={ACTION}
          onClick={() => void window.api.remote.retry(remote.host)}
        >
          Retry now
        </button>
      ) : null}
    </span>
  )
}
