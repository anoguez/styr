import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RemoteState } from '@core/types.js'
import { RemoteContext, boardAccess } from '../lib/remoteStatus.js'
import { PickerGuard } from './PickerGuard.js'

// Every Browse button (a task's folder and context files, the Settings path fields) sits in a
// `PickerGuard`: off on a remote workspace, whose host could not use a path from this computer.

const state: RemoteState = {
  enabled: true,
  hosts: [{ host: 'devbox', status: 'connected' }],
  workspaces: { cloud: { host: 'devbox', remoteWorkspaceId: 'default', live: true } }
}

function render(workspaceId: string): string {
  return renderToStaticMarkup(
    createElement(
      RemoteContext.Provider,
      { value: { state, access: boardAccess(state, workspaceId) } },
      createElement(PickerGuard, {
        title: 'Choose a folder',
        children: (disabled: boolean) => createElement('button', { disabled }, 'Browse')
      })
    )
  )
}

describe('PickerGuard', () => {
  it('disables Browse on a remote workspace, saying the path is on the host', () => {
    expect(render('cloud')).toBe(
      '<span title="This path is on devbox; type it. Browse picks from this computer." class="inline-flex"><button disabled="">Browse</button></span>'
    )
  })

  it('leaves Browse working on a local workspace', () => {
    expect(render('default')).toBe(
      '<span title="Choose a folder" class="inline-flex"><button>Browse</button></span>'
    )
  })
})
