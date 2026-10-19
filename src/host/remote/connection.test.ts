import { describe, expect, it } from 'vitest'
import type { RemoteHostState } from '@core/types.js'
import {
  HELLO_TIMEOUT_MS,
  RemoteConnection,
  exitReason,
  type ConnectionEvents
} from './connection.js'
import { PROTOCOL_VERSION } from '../rpc/jsonRpc.js'
import { HELLO, fakeClock, fakeServer, settle } from './remoteFixture.js'

function setup(handlers = {}) {
  const server = fakeServer(handlers)
  const clock = fakeClock()
  const log: string[] = []
  const states: RemoteHostState[] = []
  const events: ConnectionEvents = {
    state: (state) => void states.push(state),
    connected: (_hello, reconnect) => void log.push(reconnect ? 'reconnected' : 'connected'),
    disconnected: () => void log.push('disconnected'),
    notification: (method) => void log.push(`notification ${method}`)
  }
  const connection = new RemoteConnection('devbox', { spawn: server.spawn, ...clock.ports }, events)
  return { server, clock, log, states, connection, status: () => connection.state().status }
}

describe('RemoteConnection', () => {
  it('connects once the server says hello, and reports its version', () => {
    const { server, connection, log, status } = setup()
    expect(status()).toBe('offline')
    connection.start()
    expect(status()).toBe('connecting')
    expect(server.children).toHaveLength(1)
    server.hello()
    expect(status()).toBe('connected')
    expect(connection.state().serverVersion).toBe(HELLO.version)
    expect(log).toEqual(['connected'])
  })

  it('backs off 1s, 2s, 4s … up to 30s while the host is unreachable, with ssh’s words', () => {
    const { server, clock, connection, status } = setup()
    connection.start()
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      server.drop('ssh: connect to host devbox port 22: Connection refused\n')
      expect(status()).toBe('reconnecting')
      expect(connection.state().lastError).toBe(
        'ssh: connect to host devbox port 22: Connection refused'
      )
      const [delay] = clock.pending()
      delays.push(delay!)
      expect(connection.state().retryAt).toBe(clock.ports.now() + delay!)
      clock.advance(delay!)
      expect(status()).toBe('connecting')
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    expect(server.children).toHaveLength(8)
  })

  it('stops backing off once connected, and starts again from 1s after the next drop', () => {
    const { server, clock, connection, log } = setup()
    connection.start()
    server.drop()
    clock.advance(1000)
    server.drop()
    clock.advance(2000)
    server.hello()
    expect(clock.pending()).toEqual([])
    server.drop('Connection reset by peer')
    expect(log).toEqual(['connected', 'disconnected'])
    expect(clock.pending()).toEqual([1000])
    clock.advance(1000)
    server.hello()
    expect(log).toEqual(['connected', 'disconnected', 'reconnected'])
  })

  it('Retry now skips the wait', () => {
    const { server, clock, connection, status } = setup()
    connection.start()
    server.drop()
    server.drop()
    expect(clock.pending()).toEqual([1000])
    clock.advance(1000)
    server.drop()
    expect(clock.pending()).toEqual([2000])
    connection.retryNow()
    expect(status()).toBe('connecting')
    // The backoff timer is gone; only the new attempt's hello deadline is armed.
    expect(clock.pending()).toEqual([HELLO_TIMEOUT_MS])
  })

  it('queues nothing: a request while disconnected rejects at once, and a dropped link rejects what waited', async () => {
    const { server, connection } = setup({ slow: () => new Promise(() => {}) })
    connection.start()
    await expect(connection.request('tasks:list')).rejects.toThrow(/Not connected to devbox/)
    server.hello()
    const waiting = connection.request('slow')
    await settle()
    server.drop()
    await expect(waiting).rejects.toThrow(/closed/)
    connection.notify('terminal:write', ['abc', 'x'])
    expect(server.notifications).toEqual([])
  })

  it('goes offline while the machine sleeps, without a timer, and reconnects at once on wake', () => {
    const { server, clock, connection, status, log } = setup()
    connection.start()
    server.hello()
    connection.suspend('The computer went to sleep.')
    expect(status()).toBe('offline')
    expect(server.children[0]!.killed).toBe(true)
    expect(clock.pending()).toEqual([])
    expect(log).toEqual(['connected', 'disconnected'])
    connection.wake(true)
    expect(status()).toBe('connecting')
    server.hello()
    expect(log.at(-1)).toBe('reconnected')
  })

  it('replaces a link that looks alive after a wake, since it may have died asleep', () => {
    const { server, connection } = setup()
    connection.start()
    server.hello()
    connection.wake(true)
    expect(server.children[0]!.killed).toBe(true)
    expect(server.children).toHaveLength(2)
    // The network coming back leaves a live link alone.
    server.hello()
    connection.wake(false)
    expect(server.children).toHaveLength(2)
  })

  it('stops for good: no child, no timer, no reconnect', () => {
    const { server, clock, connection, status } = setup()
    connection.start()
    server.drop()
    connection.stop()
    expect(status()).toBe('offline')
    expect(clock.pending()).toEqual([])
    connection.retryNow()
    connection.wake(true)
    expect(server.children).toHaveLength(1)
  })

  it('gives up on a link that connects but never says hello, and backs off as usual', () => {
    const { server, clock, connection, status } = setup()
    connection.start()
    server.children[0]!.stderr('Welcome to devbox\n')
    expect(clock.pending()).toEqual([HELLO_TIMEOUT_MS])
    clock.advance(HELLO_TIMEOUT_MS)
    expect(server.children[0]!.killed).toBe(true)
    expect(status()).toBe('reconnecting')
    expect(connection.state().lastError).toBe('devbox did not answer within 15s: Welcome to devbox')
    expect(clock.pending()).toEqual([1000])
    clock.advance(1000)
    server.hello()
    expect(status()).toBe('connected')
    // Once connected, no deadline is left armed.
    expect(clock.pending()).toEqual([])
  })

  it('passes the server’s notifications on', () => {
    const { server, connection, log } = setup()
    connection.start()
    server.hello()
    server.push('tasks:changed')
    expect(log).toEqual(['connected', 'notification tasks:changed'])
  })

  it('forwards nothing to a server on another protocol, keeps the link (no retry loop), and reconnects on Retry', async () => {
    const { server, clock, connection, log, status } = setup({ 'tasks:list': () => [] })
    connection.start()
    server.hello({ ...HELLO, protocol: PROTOCOL_VERSION + 1, version: '0.1.0' })
    expect(status()).toBe('incompatible')
    expect(connection.connected).toBe(false)
    expect(connection.state()).toMatchObject({
      serverVersion: '0.1.0',
      lastError: expect.stringMatching(/devbox runs Styr 0\.1\.0.*not this app's.*upgraded/)
    })
    // No connected event, no notifications, requests refused, nothing armed.
    server.push('tasks:changed')
    expect(log).toEqual([])
    await expect(connection.request('tasks:list')).rejects.toThrow(/Not connected/)
    expect(server.calls).toEqual([])
    expect(clock.pending()).toEqual([])
    expect(server.children[0]!.killed).toBe(false)
    // The network coming back does not replace it; Retry (after the upgrade) does.
    connection.wake(false)
    expect(server.children).toHaveLength(1)
    connection.retryNow()
    expect(server.children[0]!.killed).toBe(true)
    expect(server.children).toHaveLength(2)
    server.hello()
    expect(status()).toBe('connected')
    expect(log).toEqual(['connected'])
  })

  it('reports when the server started, for its uptime', () => {
    const { server, connection } = setup()
    connection.start()
    server.hello()
    expect(connection.state().serverStartedAt).toBe(HELLO.startedAt)
    expect(connection.server?.pid).toBe(HELLO.pid)
  })
})

describe('exitReason', () => {
  it('prefers ssh’s last line, then names a missing ssh, then the exit code', () => {
    expect(exitReason('Warning: x\nPermission denied (publickey).\n', 255)).toBe(
      'Permission denied (publickey).'
    )
    const missing = Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })
    expect(exitReason('', null, missing)).toBe('ssh was not found on PATH.')
    expect(exitReason('', 2)).toBe('ssh exited with code 2.')
  })

  it('tells the user to accept an unknown or changed host key themselves, then Retry', () => {
    expect(exitReason('Host key verification failed.\n', 255, undefined, 'devbox')).toBe(
      'Host key verification failed. Run “ssh devbox” once in a terminal to check and accept the key, then click Retry.'
    )
  })
})
