import type { ReactNode } from 'react'
import { Card, Hint, SwitchRow } from '../ui.js'
import type { SectionProps } from './sections.js'

export function ExperimentalSection({ draft, patch }: SectionProps): ReactNode {
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
      </Card>
      <Hint>Experimental features can change or disappear between releases.</Hint>
    </>
  )
}
