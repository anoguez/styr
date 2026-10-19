import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { RemoteState, WorkspacesActivity } from '@core/types.js'

// The switcher reads the platform from the preload when it loads.
vi.hoisted(() => {
  Object.assign(globalThis, { window: { api: { app: { platform: 'darwin' } } } })
})

import type { Workspaces } from '../hooks/useWorkspaces.js'
import { RemoteContext, boardAccess } from '../lib/remoteStatus.js'
import { NewWorkspaceDialog } from './WorkspaceSwitcher.js'
import { NewWorkspaceForm, WorkspacesPane } from './WorkspacesPane.js'
import { RemoteSection } from './settings/RemoteSection.js'

// New workspace → Remote host is offered from every entry with remote workspaces on
// (Experimental), and nowhere with them off: the switcher's dialog, Settings → Workspaces and
// Settings → Remote hosts' Set up a host… (the palette's entry is in `commandEntries.test.ts`).

const OFF: RemoteState = { enabled: false, hosts: [], workspaces: {} }
const ON: RemoteState = { enabled: true, hosts: [], workspaces: {} }

function render(state: RemoteState, element: ReactNode): string {
  return renderToStaticMarkup(
    createElement(
      RemoteContext.Provider,
      { value: { state, access: boardAccess(state, 'default') } },
      element
    )
  )
}

const noop = (): void => undefined
const form = createElement(NewWorkspaceForm, {
  onCreate: async () => true,
  onCreated: noop,
  onCancel: noop,
  onRemote: noop
})

const workspaces: Workspaces = {
  overview: {
    activeId: 'default',
    workspaces: [{ id: 'default', name: 'Default', taskCount: 0, liveSessions: 0 }]
  },
  names: new Map([['default', 'Default']]),
  activity: { byWorkspace: {} } as unknown as WorkspacesActivity,
  apply: noop
}

describe('Settings → Workspaces → New workspace', () => {
  it('offers This computer / Remote host with remote workspaces on', () => {
    const html = render(ON, form)
    expect(html).toContain('aria-label="Where the workspace lives"')
    expect(html).toContain('Remote host')
    expect(html).toContain('aria-label="New workspace name"')
  })

  it('is the plain name form, with no toggle, with them off', () => {
    const html = render(OFF, form)
    expect(html).not.toContain('Where the workspace lives')
    expect(html).not.toContain('Remote host')
    expect(html.startsWith('<form class="flex gap-2">')).toBe(true)
  })

  it('shows the pane’s New workspace button either way', () => {
    for (const state of [ON, OFF]) {
      const html = render(
        state,
        createElement(WorkspacesPane, {
          workspaces,
          editedWorkspaceId: 'default',
          onEdit: noop,
          onNewRemote: noop
        })
      )
      expect(html).toContain('New workspace')
    }
  })
})

describe('the switcher’s New workspace dialog', () => {
  const dialog = (initialMode?: 'local' | 'remote') =>
    createElement(NewWorkspaceDialog, {
      initialMode,
      onCreate: async () => undefined,
      onApply: noop,
      onClose: noop
    })

  it('has no toggle with remote workspaces off, even when asked for Remote host', () => {
    for (const mode of [undefined, 'remote'] as const) {
      const html = render(OFF, dialog(mode))
      expect(html).not.toContain('Where the workspace lives')
      expect(html).toContain('Create workspace')
    }
  })

  it('opens straight on the remote setup when asked, with no Agent CLI choice', () => {
    const html = render(ON, dialog('remote'))
    expect(html).toContain('aria-label="Where the workspace lives"')
    expect(html).toContain('Continue')
    expect(html).not.toContain('Agent CLI')
    expect(html).not.toContain('Create workspace')
  })
})

describe('Settings → Remote hosts', () => {
  it('offers Set up a host… and no form to link a workspace by id', () => {
    const empty = render(ON, createElement(RemoteSection, { workspaces, onSetUp: noop }))
    expect(empty).toContain('Set up a host…')
    expect(empty).toContain('No remote hosts yet')
    expect(empty).not.toContain('Link a workspace')
    expect(empty).not.toContain('Server command')
    expect(empty).not.toContain('Workspace on the host')

    const withHost = render(
      { ...ON, hosts: [{ host: 'devbox', status: 'connected' }] },
      createElement(RemoteSection, { workspaces, onSetUp: noop })
    )
    expect(withHost).toContain('Set up a host…')
    expect(withHost).toContain('devbox')
  })

  it('has no button with remote workspaces off', () => {
    expect(render(OFF, createElement(RemoteSection, { workspaces, onSetUp: noop }))).not.toContain(
      'Set up a host…'
    )
  })
})
