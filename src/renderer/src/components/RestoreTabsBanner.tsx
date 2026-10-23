import type { ReactNode } from 'react'
import { offerText } from '@core/terminalLayout.js'
import type { TabRestore } from '../hooks/useTabRestore.js'
import { Button } from './ui.js'

/** The offer to reopen the last session's terminal tabs, and what a restore skipped. */
export function RestoreTabsBanner({ restore }: { restore: TabRestore }): ReactNode {
  const { offer, summary, busy } = restore
  if (!offer && !summary) return null
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-edge bg-raised/60 px-4 py-2"
    >
      <p className="min-w-0 flex-1 text-[12px] text-ink">
        {offer && !(offer.auto && busy) ? offerText(offer) : (summary ?? 'Restoring tabs…')}
      </p>
      {offer && !offer.auto ? (
        <>
          <Button variant="primary" disabled={busy} onClick={restore.restore}>
            Restore
          </Button>
          <Button variant="subtle" disabled={busy} onClick={restore.dismiss}>
            Dismiss
          </Button>
        </>
      ) : summary ? (
        <Button variant="subtle" onClick={restore.closeSummary}>
          Close
        </Button>
      ) : null}
    </div>
  )
}
