import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AccessState } from '@core/types.js'
import { AddDeviceDialog, ConnectIntroDialog } from './ConnectDialogs.js'

const state = (over: Partial<AccessState> = {}): AccessState => ({
  enabled: true,
  port: 7878,
  keepAwake: false,
  listening: true,
  interfaces: [{ name: 'en0', address: '192.168.1.20', kind: 'lan' }],
  devices: [],
  fingerprint: 'ab'.repeat(32),
  workspaces: [
    { id: 'default', name: 'Default', shared: false },
    { id: 'client', name: 'Client work', shared: false }
  ],
  workspaceShared: false,
  ...over
})

const add = (s: AccessState, openWorkspaceId = 'client'): string =>
  renderToStaticMarkup(
    createElement(AddDeviceDialog, {
      state: s,
      openWorkspaceId,
      onShare: async () => undefined,
      onClose: () => undefined
    })
  )

describe('ConnectIntroDialog', () => {
  const html = renderToStaticMarkup(
    createElement(ConnectIntroDialog, { onStart: async () => undefined, onLater: () => undefined })
  )

  it('says what connecting gives, and that it stays on the network', () => {
    expect(html).toContain('Connect a device to this computer')
    expect(html).toContain('Pick up where you left off')
    expect(html).toContain('Stay in the loop')
    expect(html).toContain('never the internet')
    expect(html).toContain('end-to-end encrypted')
  })

  it('offers Later and Get started', () => {
    expect(html).toContain('>Later<')
    expect(html).toContain('>Get started<')
  })
})

describe('AddDeviceDialog', () => {
  it('asks what to share first while nothing is, with the open workspace picked', () => {
    const html = add(state())
    expect(html).toContain('Choose what it can open')
    expect(html).not.toContain('Pairing QR code')
    // Only the open workspace is ticked: nothing else is shared without asking.
    const ticked = [...html.matchAll(/<input type="checkbox"([^>]*)\/>/g)].map((match) =>
      match[1]!.includes('checked')
    )
    expect(ticked).toEqual([false, true])
  })

  it('offers no workspace when the open one is not on this computer, and cannot continue', () => {
    const html = add(state(), 'remote-stub')
    expect(html).not.toMatch(/checked=""/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Continue<\/button>/)
  })

  it('goes straight to the code once something is shared', () => {
    const html = add(
      state({
        workspaceShared: true,
        workspaces: [{ id: 'default', name: 'Default', shared: true }]
      })
    )
    expect(html).toContain('Add a device')
    expect(html).toContain('Scan this with the Styr app')
    expect(html).toContain('same network as this computer')
    expect(html).toContain('works once and for two minutes')
    // The code is made by the main process, not before the dialog asks for it.
    expect(html).toContain('Making a code…')
  })

  it("shows the start of this computer's fingerprint to check against", () => {
    const html = add(state({ workspaceShared: true, fingerprint: 'abcdef01'.repeat(8) }))
    expect(html).toContain('abcd ef01')
  })
})
