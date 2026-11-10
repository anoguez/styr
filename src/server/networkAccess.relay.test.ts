import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createAccessStore } from '@host/remoteAccess/accessStore.js'
import { createSecureClientHandshake } from '@host/remoteAccess/secureClient.js'
import type { SecureFrameChannel } from '@host/remoteAccess/secureSession.js'
import { createAllowList, type AllowList } from './relay/allowList.js'
import { startRelay, type Relay } from './relay/relay.js'
import { createNetworkAccess } from './networkAccess.js'
import { networkHost } from './networkFixture.js'

/**
 * The host's relay client against a real `styr relay` and a real hub: a device pairs through the
 * relay end to end, its calls pass the gate, and revoking it ends its session.
 */

/** A phone that dials the relay for one host and runs protocol 2 with it. */
class RelayPhone {
  readonly socket: WebSocket
  private queue: string[] = []
  private waiting: ((text: string | undefined) => void)[] = []
  closed?: number

  constructor(port: number, fingerprint: string) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/phone/${fingerprint}`)
    this.socket.on('message', (data) => {
      const text = data.toString()
      const waiter = this.waiting.shift()
      if (waiter) waiter(text)
      else this.queue.push(text)
    })
    this.socket.on('close', (code) => {
      this.closed = code
      for (const waiter of this.waiting.splice(0)) waiter(undefined)
    })
    this.socket.on('error', () => undefined)
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve())
      this.socket.once('error', reject)
    })
  }

  next(): Promise<string | undefined> {
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.closed !== undefined) return Promise.resolve(undefined)
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  async signIn(
    fingerprint: string,
    signIn: Parameters<typeof createSecureClientHandshake>[0]['signIn'],
    identity = deviceIdentity()
  ): Promise<{ channel: SecureFrameChannel; deviceId?: string }> {
    const client = createSecureClientHandshake({
      pinnedFingerprint: fingerprint,
      identity,
      signIn,
      maxMessageBytes: 1024 * 1024
    })
    await this.opened()
    this.socket.send(client.start())
    for (;;) {
      const frame = await this.next()
      if (frame === undefined) throw new Error(`closed ${this.closed}`)
      const step = client.receive(frame)
      if (step.kind === 'ready') return { channel: step.channel, deviceId: step.deviceId }
      if (step.kind === 'send') for (const out of step.frames) this.socket.send(out)
    }
  }

  /** One JSON-RPC call, sealed; the answer with its id. */
  async call(channel: SecureFrameChannel, id: number, method: string): Promise<unknown> {
    for (const frame of channel.seal(JSON.stringify({ jsonrpc: '2.0', id, method, params: [] }))) {
      this.socket.send(frame)
    }
    for (;;) {
      const frame = await this.next()
      if (frame === undefined) throw new Error(`closed ${this.closed}`)
      const text = channel.open(frame)
      if (text === undefined) continue
      const message = JSON.parse(text) as { id?: number }
      if (message.id === id) return message
    }
  }
}

function deviceIdentity() {
  const pair = generateKeyPairSync('ed25519')
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  }
}

describe('network access through a relay', () => {
  let host: ReturnType<typeof networkHost>
  let allowList: AllowList
  let relay: Relay
  const stops: (() => Promise<void>)[] = []

  beforeEach(async () => {
    host = networkHost()
    allowList = createAllowList(`${host.dir}/relay.json`)
    relay = await startRelay({ allowList, log: () => undefined }, '127.0.0.1', 0)
  })
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop()
    await relay.close()
    host.cleanup()
  })

  function create() {
    const access = createNetworkAccess({
      hub: host.hub,
      gate: {
        isOpen: (id) => host.state.shared.has(id),
        activeId: () => host.state.active,
        sessionWorkspace: () => ({ exists: false }),
        currentGlobal: () => host.state.global,
        sourcesOf: () => []
      },
      keepAwake: { hold: () => 0, release: () => undefined },
      broadcast: () => undefined,
      log: (message) => host.state.log.push(message),
      store: createAccessStore({ path: host.storePath, now: () => host.state.clock }),
      relayTimings: { backoff: { firstMs: 20, maxMs: 40 } }
    })
    stops.push(() => access.service.stop())
    return access
  }

  it('waits to be allowed, then pairs a device and answers it through the gate', async () => {
    const { service } = create()
    await service.configure({
      relay: { enabled: true, address: '127.0.0.1', port: relay.address.port }
    })
    await vi.waitFor(() => expect(service.state().relayStatus).toBe('notAllowed'))
    expect(() => service.pair()).toThrow(/not connected to the relay/)

    allowList.allow(service.state().fingerprint)
    await vi.waitFor(() => expect(service.state().relayStatus).toBe('connected'))
    const uri = new URL(service.pair().uri)
    expect(uri.searchParams.get('v')).toBe('2')
    expect(uri.searchParams.get('relay')).toBe(`127.0.0.1:${relay.address.port}`)
    const fingerprint = uri.searchParams.get('fp')!

    const phone = new RelayPhone(relay.address.port, fingerprint)
    const identity = deviceIdentity()
    const { channel, deviceId } = await phone.signIn(
      fingerprint,
      { type: 'pair', name: 'iPhone', secret: uri.searchParams.get('secret')! },
      identity
    )
    await vi.waitFor(() =>
      expect(service.state().devices).toEqual([
        expect.objectContaining({ id: deviceId, name: 'iPhone', connected: true })
      ])
    )
    expect(await phone.call(channel, 1, 'tasks:list')).toMatchObject({
      result: [{ id: 'TASK-1@open' }]
    })
    // The workspace's own `remoteAccess` still decides.
    host.state.active = 'closed'
    expect(await phone.call(channel, 2, 'tasks:list')).toMatchObject({
      error: { code: -32001 }
    })

    // A second session signs in with the stored key; revoking ends both.
    const again = new RelayPhone(relay.address.port, fingerprint)
    await again.signIn(fingerprint, { type: 'auth', deviceId: deviceId! }, identity)
    service.revoke(deviceId!)
    await vi.waitFor(() => expect([phone.closed, again.closed]).toEqual([4403, 4403]))
  })

  it('refuses protocol 1 through the relay, and says when the relay goes away', async () => {
    allowList.allow(
      createAccessStore({ path: host.storePath, now: Date.now }).identity().fingerprint
    )
    const { service } = create()
    await service.configure({
      relay: { enabled: true, address: '127.0.0.1', port: relay.address.port }
    })
    await vi.waitFor(() => expect(service.state().relayStatus).toBe('connected'))

    const phone = new RelayPhone(relay.address.port, service.state().fingerprint)
    await phone.opened()
    phone.socket.send(JSON.stringify({ type: 'hello', protocol: 1, clientNonce: 'ab'.repeat(16) }))
    expect(await phone.next()).toBeUndefined()
    expect(phone.closed).toBe(4401)

    await relay.close()
    await vi.waitFor(() => expect(service.state().relayStatus).toBe('unreachable'))
    expect(() => service.pair()).toThrow(/not connected to the relay/)
  })
})
