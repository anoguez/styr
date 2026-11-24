import type { ReactNode } from 'react'
import { Card, Hint, SwitchRow } from '../ui.js'
import type { SectionProps } from './sections.js'

/**
 * Settings → Remote access, for a workspace on a remote host only: whether devices paired with that
 * host's `styr serve` may open it. Saved on the host with the rest of the workspace's settings. A
 * workspace on this computer is shared from Connections instead.
 */
export function WorkspaceSharingSection({ draft, patch }: SectionProps): ReactNode {
  return (
    <div className="flex flex-col gap-2.5">
      <Card>
        <SwitchRow
          checked={draft.remoteAccess}
          onChange={(remoteAccess) => patch({ remoteAccess })}
          label="Allow devices paired with its host to open this workspace"
          hint="Devices paired with the host (styr serve pair) can list, open and use this workspace, and run commands in it. Off, they cannot see it."
        />
      </Card>
      <Hint>
        Other workspaces are not affected. The host must be listening for devices (styr serve
        --listen).
      </Hint>
    </div>
  )
}
