import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useBrowseTarget, type BrowseTarget } from '../lib/remoteStatus.js'
import { DirectoryPicker } from './DirectoryPicker.js'
import { Modal } from './ui.js'

/** What the native dialogs need, `window.api.settings` in the app. */
export interface NativePickers {
  pickDirectory(start?: string): Promise<string | null>
  pickFiles(start?: string): Promise<string[]>
}

/**
 * What a click on Browse does: on a remote workspace, open the in-app picker over the host's
 * folders (`openPicker`); on a local one, this computer's own dialog, its choice passed to
 * `onPick`; where the host cannot be listed (`elsewhere`), nothing.
 */
export function startBrowse(
  target: BrowseTarget,
  kind: 'folder' | 'files',
  start: string | undefined,
  {
    native,
    openPicker,
    onPick
  }: {
    native: NativePickers
    openPicker: () => void
    onPick: (paths: string[]) => void
  }
): void {
  if (target.kind === 'remote') return openPicker()
  if (target.kind !== 'native') return
  if (kind === 'folder') {
    void native.pickDirectory(start || undefined).then((picked) => {
      if (picked) onPick([picked])
    })
  } else {
    void native.pickFiles(start || undefined).then((picked) => {
      if (picked.length > 0) onPick(picked)
    })
  }
}

/**
 * A Browse button that picks a path on the machine the workspace lives on, as Browse does locally
 * (`docs/architecture/remote.md`, Local-only actions). On a local workspace it opens this
 * computer's dialog; on a remote one, the in-app `DirectoryPicker` over the host's folders and
 * files, so the path picked is the host's. `local` keeps a path that always belongs to this
 * computer (the storage folder) on the native dialog.
 */
export function PathBrowse({
  kind,
  start,
  title,
  local = false,
  className = 'inline-flex',
  onPick,
  children
}: {
  /** A folder, or files (the native dialog may pick several; the in-app picker picks one). */
  kind: 'folder' | 'files'
  /** Where browsing starts: the current value, or the repo. Empty starts in the home folder. */
  start?: string
  /** The button's own tooltip. */
  title?: string
  local?: boolean
  className?: string
  onPick: (paths: string[]) => void
  children: (browse: () => void, disabled: boolean) => ReactNode
}): ReactNode {
  const browseTarget = useBrowseTarget()
  const target = local ? { kind: 'native' as const } : browseTarget
  const [picking, setPicking] = useState(false)

  const browse = (): void =>
    startBrowse(target, kind, start, {
      native: window.api.settings,
      openPicker: () => setPicking(true),
      onPick
    })

  return (
    <span title={target.kind === 'elsewhere' ? target.reason : title} className={className}>
      {children(browse, target.kind === 'elsewhere')}
      {picking && target.kind === 'remote'
        ? createPortal(
            <Modal
              title={kind === 'folder' ? 'Choose a folder' : 'Choose a file'}
              subtitle={`On ${target.host}, where this workspace lives.`}
              onClose={() => setPicking(false)}
            >
              <DirectoryPicker
                embedded
                files={kind === 'files'}
                start={start || '~'}
                onClose={() => setPicking(false)}
                onChoose={(path) => {
                  setPicking(false)
                  onPick([path])
                }}
              />
            </Modal>,
            document.body
          )
        : null}
    </span>
  )
}
