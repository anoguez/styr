import { describe, expect, it } from 'vitest'
import type { RemoteState } from '@core/types.js'
import {
  boardAccess,
  connectionLabel,
  remoteFileAction,
  remoteNote,
  retryIn,
  serverStopQuestion,
  sessionDisconnected,
  transferLabel,
  uptime
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

describe('Settings → Remote hosts', () => {
  it('reads a server’s uptime from when it started', () => {
    const start = '2026-10-19T00:00:00.000Z'
    const at = (minutes: number) => Date.parse(start) + minutes * 60_000
    expect(uptime(start, at(0.5))).toBe('under a minute')
    expect(uptime(start, at(12))).toBe('12m')
    expect(uptime(start, at(125))).toBe('2h 5m')
    expect(uptime(start, at(3 * 1440 + 4 * 60 + 7))).toBe('3d 4h')
    expect(uptime(undefined, at(1))).toBeUndefined()
  })

  it('lists the agents a restart or stop would end before asking', () => {
    const question = serverStopQuestion('devbox', 'stop', {
      known: true,
      agents: [{ title: 'Fix login', workspace: 'Client work' }, { title: 'Docs' }]
    })
    expect(question).toContain('Stop the Styr server on devbox?')
    expect(question).toContain('ends these 2 agents:\n• Fix login (Client work)\n• Docs')
    expect(question).toContain('resume each from its card')
    expect(serverStopQuestion('devbox', 'restart', { known: true, agents: [] })).toBe(
      'Upgrade the server on devbox? It restarts to take over.\n\nNo agents are running there.'
    )
    expect(serverStopQuestion('devbox', 'stop', { known: false, agents: [] })).toMatch(
      /not connected, so Styr cannot tell which agents are running/
    )
    expect(
      serverStopQuestion('devbox', 'restart', { known: false, incompatible: true, agents: [] })
    ).toMatch(/devbox runs an incompatible server, so Styr cannot tell which agents are running/)
  })

  it('says how the server reached the host, upload fallback included', () => {
    expect(transferLabel('download')).toMatch(/host downloaded/)
    expect(transferLabel('upload')).toMatch(/could not download.*uploaded it over ssh/)
  })

  it('names a server this app cannot talk to, and a host the user disconnected', () => {
    const host = { host: 'devbox', status: 'incompatible' as const }
    expect(connectionLabel(host)).toBe('devbox needs a server upgrade')
    expect(connectionLabel({ host: 'devbox', status: 'offline', userDisconnected: true })).toBe(
      'devbox disconnected'
    )
    const state = {
      enabled: true,
      hosts: [host],
      workspaces: { stub: { host: 'devbox', remoteWorkspaceId: 'default', live: false } }
    }
    expect(boardAccess(state, 'stub').reason).toMatch(/cannot talk to\. Upgrade the server/)
  })
})
