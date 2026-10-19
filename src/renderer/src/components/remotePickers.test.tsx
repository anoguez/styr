import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { RemoteState } from '@core/types.js'
import { RemoteContext, boardAccess, browseTarget } from '../lib/remoteStatus.js'
import { PathBrowse, startBrowse } from './PathBrowse.js'

// Every Browse button (a task's folder and context files, the Settings path fields) is a
// `PathBrowse`: it picks a path on the machine the workspace lives on. A local workspace opens this
// computer's dialog; a remote one opens the in-app picker, fed by `terminal:listDirectories`, which
// the router sends to the workspace's server (`ACTIVE_CHANNELS`, `host/remote/channels.ts`).

const state: RemoteState = {
  enabled: true,
  hosts: [{ host: 'devbox', status: 'connected' }],
  workspaces: { cloud: { host: 'devbox', remoteWorkspaceId: 'default', live: true } }
}

function render(workspaceId: string, { local = false, notOpen = false } = {}): string {
  return renderToStaticMarkup(
    createElement(
      RemoteContext.Provider,
      { value: { state, access: boardAccess(state, workspaceId), notOpen } },
      createElement(PathBrowse, {
        kind: 'folder',
        title: 'Choose a folder',
        local,
        onPick: () => undefined,
        children: (_browse: () => void, disabled: boolean) =>
          createElement('button', { disabled }, 'Browse')
      })
    )
  )
}

function click(workspaceId: string, kind: 'folder' | 'files', local = false) {
  const native = {
    pickDirectory: vi.fn(() => Promise.resolve('/Users/me/repo')),
    pickFiles: vi.fn(() => Promise.resolve(['/Users/me/a.md']))
  }
  const openPicker = vi.fn()
  const onPick = vi.fn()
  const target = local
    ? ({ kind: 'native' } as const)
    : browseTarget(boardAccess(state, workspaceId))
  startBrowse(target, kind, '/srv/app', { native, openPicker, onPick })
  return { native, openPicker, onPick }
}

describe('PathBrowse', () => {
  it('opens the in-app picker on a remote workspace, never this computer’s dialog', () => {
    for (const kind of ['folder', 'files'] as const) {
      const { native, openPicker } = click('cloud', kind)
      expect(openPicker).toHaveBeenCalledOnce()
      expect(native.pickDirectory).not.toHaveBeenCalled()
      expect(native.pickFiles).not.toHaveBeenCalled()
    }
  })

  it('opens the native dialog on a local workspace', async () => {
    const folder = click('default', 'folder')
    expect(folder.openPicker).not.toHaveBeenCalled()
    expect(folder.native.pickDirectory).toHaveBeenCalledWith('/srv/app')
    await vi.waitFor(() => expect(folder.onPick).toHaveBeenCalledWith(['/Users/me/repo']))
    const files = click('default', 'files')
    expect(files.native.pickFiles).toHaveBeenCalledWith('/srv/app')
    await vi.waitFor(() => expect(files.onPick).toHaveBeenCalledWith(['/Users/me/a.md']))
  })

  it('keeps a local-only path such as the storage folder on the native dialog', () => {
    const { native, openPicker } = click('cloud', 'folder', true)
    expect(openPicker).not.toHaveBeenCalled()
    expect(native.pickDirectory).toHaveBeenCalled()
  })

  it('leaves Browse enabled on a remote workspace and on a local one', () => {
    const enabled =
      '<span title="Choose a folder" class="inline-flex"><button>Browse</button></span>'
    expect(render('cloud')).toBe(enabled)
    expect(render('default')).toBe(enabled)
    expect(render('cloud', { local: true })).toBe(enabled)
  })

  it('says to open a remote workspace that Settings edits from another one', () => {
    expect(render('cloud', { notOpen: true })).toBe(
      '<span title="This path is on devbox. Open the workspace to browse it there, or type it." class="inline-flex"><button disabled="">Browse</button></span>'
    )
    // A local workspace's path is this computer's, whichever workspace is open.
    expect(render('default', { notOpen: true })).toContain('<button>Browse</button>')
  })
})
