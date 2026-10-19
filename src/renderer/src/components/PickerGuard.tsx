import type { ReactNode } from 'react'
import { localPickerBlocked, useBoardAccess } from '../lib/remoteStatus.js'

/**
 * Wraps a Browse button, which opens this computer's file dialog. On a remote workspace a path
 * picked there would be stored for the host, which would then quietly start the agent in its home
 * folder; so the button is disabled, and the wrapper (a disabled button takes no hover) says to
 * type the path instead.
 */
export function PickerGuard({
  title,
  className = 'inline-flex',
  local = false,
  children
}: {
  /** The button's own tooltip, while it works. */
  title?: string
  className?: string
  /** The path belongs to this computer whatever the workspace (the storage folder): never off. */
  local?: boolean
  children: (disabled: boolean) => ReactNode
}): ReactNode {
  const access = useBoardAccess()
  const blocked = local ? undefined : localPickerBlocked(access)
  return (
    <span title={blocked ?? title} className={className}>
      {children(blocked !== undefined)}
    </span>
  )
}
