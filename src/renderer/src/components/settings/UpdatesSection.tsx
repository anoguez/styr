import { useEffect, useState, type ReactNode } from 'react'
import { useReleaseNotes, useUpdates } from '../../hooks/useUpdates.js'
import { WhatsNewDialog } from '../WhatsNewDialog.js'
import { Button, Card, SwitchRow } from '../ui.js'
import { describeUpdate } from './draft.js'
import type { SectionProps } from './sections.js'

export function UpdatesSection({ draft, patch }: SectionProps): ReactNode {
  const update = useUpdates()
  const notes = useReleaseNotes(update)
  const [showNotes, setShowNotes] = useState(false)
  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.api.app.info().then((info) => setVersion(info.version))
  }, [])

  return (
    <>
      <Card className="flex-row items-center gap-3.5 p-3.5">
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="text-[13px] font-semibold text-ink">Styr {version || '…'}</span>
          <span className={`text-[12px] ${update?.kind === 'error' ? 'text-danger' : 'text-dim'}`}>
            {describeUpdate(update)}
          </span>
        </span>
        {update?.kind === 'ready' || update?.kind === 'downloading' ? (
          <Button
            disabled={!notes && update.kind === 'downloading'}
            onClick={() => setShowNotes(true)}
          >
            What's new in {update.version}
          </Button>
        ) : null}
        {update?.kind === 'ready' ? (
          <Button variant="primary" onClick={() => void window.api.updates.install()}>
            Restart to update
          </Button>
        ) : (
          <Button
            disabled={
              !update ||
              update.kind === 'unsupported' ||
              update.kind === 'checking' ||
              update.kind === 'downloading'
            }
            onClick={() => void window.api.updates.check()}
          >
            Check for updates
          </Button>
        )}
      </Card>
      {showNotes && (update?.kind === 'ready' || update?.kind === 'downloading') ? (
        <WhatsNewDialog
          mode="incoming"
          version={update.version}
          notes={notes}
          ready={update.kind === 'ready'}
          onRestart={() =>
            void window.api.updates.install().then((restarting) => {
              if (restarting) setShowNotes(false)
            })
          }
          onClose={() => setShowNotes(false)}
        />
      ) : null}
      <Card>
        <SwitchRow
          checked={draft.updates.checkAutomatically}
          onChange={(checkAutomatically) => patch({ updates: { checkAutomatically } })}
          label="Check for updates automatically"
          hint="When Styr opens and every few hours after. An update downloads in the background and installs the next time you quit, so running agents are never interrupted."
        />
      </Card>
    </>
  )
}
