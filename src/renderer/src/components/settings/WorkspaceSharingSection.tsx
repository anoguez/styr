import type { ReactNode } from 'react'
import { Card, Hint, SwitchRow } from '../ui.js'
import type { SectionProps } from './sections.js'

/**
 * Settings → Remote access: whether paired devices may open this workspace. The listener and the
 * devices themselves are app-wide, under Remote devices; each workspace opts in on its own.
 */
export function WorkspaceSharingSection({ draft, patch }: SectionProps): ReactNode {
  return (
    <div className="flex flex-col gap-2.5">
      <Card>
        <SwitchRow
          checked={draft.remoteAccess}
          onChange={(remoteAccess) => patch({ remoteAccess })}
          label="Allow remote clients to open this workspace"
          hint="Devices paired under Remote devices can list, open and use this workspace. Off, they cannot see it. A device that opens it moves this window to it too, as another window would, because Styr has one active workspace."
        />
      </Card>
      <Hint>
        Other workspaces are not affected. Needs Settings → Remote devices → Allow other devices to
        connect to be on.
      </Hint>
    </div>
  )
}
