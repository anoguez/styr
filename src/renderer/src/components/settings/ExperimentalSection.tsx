import { useEffect, useState, type ReactNode } from 'react'
import type { TerminalEngineAvailability } from '@core/types.js'
import { Card, Hint, SwitchRow } from '../ui.js'
import { engineChoice } from '../../lib/nativeTerminal/engineChoice.js'
import type { SectionProps } from './sections.js'

export function ExperimentalSection({ draft, patch }: SectionProps): ReactNode {
  const [engine, setEngine] = useState<TerminalEngineAvailability | null>(
    engineChoice().availabilityNow
  )
  useEffect(() => {
    void engineChoice().availability().then(setEngine)
  }, [])
  // Offered only where the engine is bundled for this platform; anywhere else there is nothing to
  // switch on, and terminals use xterm.js whatever the setting holds.
  const offerTerminal = engine?.present === true || draft.experimental.nativeTerminal

  return (
    <>
      <Card>
        <SwitchRow
          label="External sources"
          hint="Link GitHub issues to tasks. Adds a GitHub page under Integrations. Off, nothing is read from or written to GitHub."
          checked={draft.experimental.externalSources}
          onChange={(externalSources) =>
            patch({ experimental: { ...draft.experimental, externalSources } })
          }
        />
        {offerTerminal ? (
          <SwitchRow
            label="Styr Terminal"
            hint={
              engine?.override !== undefined
                ? `Set by STYR_EXPERIMENTAL_TERMINAL=${engine.override ? '1' : '0'} for this run.`
                : 'A native terminal engine in place of xterm.js, for new terminals. Command blocks, links and mouse reporting are not supported yet. If it fails, the terminal switches back to xterm.js and keeps running.'
            }
            checked={engine?.override ?? draft.experimental.nativeTerminal}
            onChange={(nativeTerminal) =>
              patch({ experimental: { ...draft.experimental, nativeTerminal } })
            }
          />
        ) : null}
      </Card>
      <Hint>Experimental features can change or disappear between releases.</Hint>
    </>
  )
}
