import { describe, expect, it } from 'vitest'
import type { RemoteState } from '@core/types.js'
import {
  boardAccess,
  remoteFileAction,
  remoteNote,
  retryIn,
  sessionDisconnected
} from './remoteStatus.js'

const link = { host: 'devbox', workspaceId: 'default' }
const state = (overrides: Partial<RemoteState> = {}): RemoteState => ({
  enabled: true,
  hosts: [{ host: 'devbox', status: 'connected' }],
  workspaces: { cloud: { host: 'devbox', remoteWorkspaceId: 'default', live: true } },
  ...overrides
})

describe('boardAccess', () => {
  it('leaves a local board writable', () => {
    expect(boardAccess(state(), 'default')).toEqual({ readOnly: false })
  })

  it('makes a live remote board writable', () => {
    expect(boardAccess(state(), 'cloud')).toMatchObject({ readOnly: false })
  })

  it('makes a disconnected remote board a read-only snapshot, saying nothing is queued', () => {
    const access = boardAccess(
      state({
        hosts: [{ host: 'devbox', status: 'reconnecting', lastError: 'Connection refused' }],
        workspaces: { cloud: { host: 'devbox', remoteWorkspaceId: 'default', live: false } }
      }),
      'cloud'
    )
    expect(access.readOnly).toBe(true)
    expect(access.reason).toBe('Read-only while devbox is disconnected. Nothing is queued.')
  })

  it('names the workspace another client moved the server to', () => {
    const access = boardAccess(
      state({
        workspaces: {
          cloud: { host: 'devbox', remoteWorkspaceId: 'default', live: false, elsewhere: 'Client' }
        }
      }),
      'cloud'
    )
    expect(access.reason).toMatch(/devbox is showing “Client”/)
  })

  it('with the flag off, says remote workspaces are off', () => {
    expect(boardAccess(state({ enabled: false }), 'cloud').reason).toMatch(/off/)
  })
})

describe('remoteNote', () => {
  it('marks remote rows: off, offline, reconnecting, or the host', () => {
    const remote = { id: 'cloud', name: 'Cloud', remote: link }
    expect(remoteNote(state(), { id: 'default', name: 'Default' })).toBeUndefined()
    expect(remoteNote(state({ enabled: false }), remote)).toBe('Remote workspaces are off')
    expect(remoteNote(state({ hosts: [] }), remote)).toBe('devbox · offline')
    expect(remoteNote(state({ hosts: [{ host: 'devbox', status: 'reconnecting' }] }), remote)).toBe(
      'devbox · reconnecting…'
    )
    expect(remoteNote(state(), remote)).toBe('devbox')
  })
})

describe('sessionDisconnected', () => {
  it('covers remote tabs whose host is down, never local ones', () => {
    const down = state({ hosts: [{ host: 'devbox', status: 'offline' }] })
    expect(sessionDisconnected(down, { id: 'a', title: '', cwd: '/', host: 'devbox' })).toBe(true)
    expect(sessionDisconnected(state(), { id: 'a', title: '', cwd: '/', host: 'devbox' })).toBe(
      false
    )
    expect(sessionDisconnected(down, { id: 'b', title: '', cwd: '/' })).toBe(false)
  })
})

describe('remoteFileAction', () => {
  const remote = boardAccess(state(), 'cloud')
  it('opens a remote file only in VS Code or Cursor, and never reveals it', () => {
    expect(remoteFileAction(remote, 'Cursor', '/srv/a.md')).toMatchObject({
      open: true,
      reveal: false
    })
    const other = remoteFileAction(remote, 'TextEdit', '/srv/a.md')
    expect(other.open).toBe(false)
    expect(other.openTitle).toContain('On devbox: /srv/a.md')
  })

  it('leaves a local file as it was', () => {
    expect(remoteFileAction({ readOnly: false }, '', '/a.md')).toMatchObject({
      open: true,
      reveal: true
    })
  })
})

describe('retryIn', () => {
  it('counts down to the next attempt while reconnecting', () => {
    expect(retryIn({ host: 'devbox', status: 'reconnecting', retryAt: 9_500 }, 1_000)).toBe(9)
    expect(retryIn({ host: 'devbox', status: 'connected' }, 1_000)).toBeUndefined()
  })
})
