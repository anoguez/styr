import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayStatus } from '@core/types/access.js'
import { createAccessStore, type AccessStore } from './accessStore.js'
import {
  MAX_RELAY_HANDSHAKING,
  relayAddressProblem,
  relayUrl,
  startRelayClient,
  type RelayClient,
  type RelaySocket,
  type RelaySocketEvents
} from './relayClient.js'
import { RELAY_CLOSE, relayRegistrationData, type HostToRelay } from './relayProtocol.js'
import { createSecureClientHandshake } from './secureClient.js'
import type { SecureFrameChannel } from './secureSession.js'

/** The relay end of the link: what the host sent, and a way to answer as the relay would. */
class FakeLink implements RelaySocket {
  bufferedAmount = 0
  readonly sent: HostToRelay[] = []
  readonly raw: string[] = []
  pings = 0
  closedWith?: number
  terminated = false

  constructor(
    readonly url: string,
    readonly events: RelaySocketEvents
  ) {}

  send(text: string): void {
    this.raw.push(text)
    const message = JSON.parse(text) as HostToRelay | { type: 'register' }
    if (message.type !== 'register') this.sent.push(message)
  }
  ping(): void {
    this.pings++
  }
  close(code?: number): void {
    this.closedWith = code
  }
  terminate(): void {
    this.terminated = true
  }

  /** The relay's side of a socket that went away. */
  hangUp(code: number): void {
    this.events.close(code, '')
  }
  deliver(message: unknown): void {
    this.events.message(typeof message === 'string' ? message : JSON.stringify(message), false)
  }
  /** Opens, answers the challenge and confirms the registration. */
  register(): void {
    this.events.open()
    this.deliver({ type: 'challenge', nonce: 'ab'.repeat(16) })
    this.deliver({ type: 'registered' })
  }
  /** Frames the host sent for one session. */
  framesFor(sessionId: string): string[] {
    return this.sent
      .filter((message) => message.type === 'frame' && message.sessionId === sessionId)
      .map((message) => (message as { frame: string }).frame)
  }
  closeFor(sessionId: string): number | undefined {
    const close = this.sent.find(
      (message) => message.type === 'close' && message.sessionId === sessionId
    )
    return close?.type === 'close' ? (close.code ?? 1000) : undefined
  }
}

const SESSION = '0123456789abcdef'

describe('relay client', () => {
  let dir: string
  let store: AccessStore
  let links: FakeLink[]
  let log: string[]
  let statuses: [RelayStatus, string | undefined][]
  let connections: number[]
  let hub: { lines: string[]; send?: (line: string) => void; closed: number }
  let client: RelayClient | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'styr-relay-client-'))
    store = createAccessStore({ path: join(dir, 'access.json'), now: () => Date.now() })
    links = []
    log = []
    statuses = []
    connections = []
    hub = { lines: [], closed: 0 }
  })

  afterEach(async () => {
    await client?.close()
    client = undefined
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  function start(): RelayClient {
    client = startRelayClient(
      {
        store,
        dial: (url, events) => {
          const link = new FakeLink(url, events)
          links.push(link)
          return link
        },
        connect: (send) => {
          hub.send = send
          return { receive: (text) => void hub.lines.push(text), close: () => void hub.closed++ }
        },
        log: (line) => log.push(line),
        onStatus: (status, error) => statuses.push([status, error]),
        onConnections: (count) => connections.push(count),
        maxMessageBytes: 1024 * 1024,
        maxBufferedBytes: 1024 * 1024,
        pingMs: 1_000,
        handshakeMs: 5_000
      },
      '100.64.0.9',
      7879
    )
    return client
  }

  const link = (): FakeLink => links.at(-1)!

  function device() {
    const pair = generateKeyPairSync('ed25519')
    return {
      privateKey: pair.privateKey,
      publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    }
  }

  /** Runs a device's protocol-2 handshake through the fake relay; its channel once ready. */
  function handshake(
    signIn: Parameters<typeof createSecureClientHandshake>[0]['signIn'],
    identity = device(),
    sessionId = SESSION
  ): { channel: SecureFrameChannel; deviceId?: string } {
    const phone = createSecureClientHandshake({
      pinnedFingerprint: store.identity().fingerprint,
      identity,
      signIn,
      maxMessageBytes: 1024 * 1024
    })
    link().deliver({ type: 'open', sessionId })
    link().deliver({ type: 'frame', sessionId, frame: phone.start() })
    let read = 0
    for (;;) {
      const frames = link().framesFor(sessionId)
      if (read === frames.length) throw new Error(`stalled; closed ${link().closeFor(sessionId)}`)
      const step = phone.receive(frames[read++]!)
      if (step.kind === 'ready') return { channel: step.channel, deviceId: step.deviceId }
      if (step.kind === 'send') {
        for (const frame of step.frames) link().deliver({ type: 'frame', sessionId, frame })
      }
    }
  }

  it('registers with a signature over the relay nonce, and says it is connected', () => {
    start()
    expect(link().url).toBe('ws://100.64.0.9:7879/host')
    link().events.open()
    link().deliver({ type: 'challenge', nonce: 'cd'.repeat(16) })
    const register = JSON.parse(link().raw[0]!) as { hostKey: string; signature: string }
    expect(register.hostKey).toBe(store.identity().publicKey)
    const key = { key: Buffer.from(register.hostKey, 'base64'), format: 'der', type: 'spki' }
    expect(
      verify(
        null,
        Buffer.from(relayRegistrationData('cd'.repeat(16))),
        key as never,
        Buffer.from(register.signature, 'base64')
      )
    ).toBe(true)
    link().deliver({ type: 'registered' })
    expect(client!.status()).toBe('connected')
    expect(statuses.at(-1)).toEqual(['connected', undefined])
  })

  it('pairs a device end to end and gives it the hub, sealed both ways', () => {
    start()
    link().register()
    const offer = store.startPairing()
    const { channel, deviceId } = handshake({ type: 'pair', name: 'iPhone', secret: offer.secret })
    expect(deviceId).toBeDefined()
    expect(store.devices().map((entry) => entry.name)).toEqual(['iPhone'])
    expect(client!.connectedDevices()).toEqual([deviceId])
    expect(connections.at(-1)).toBe(1)

    for (const frame of channel.seal('{"jsonrpc":"2.0","id":1,"method":"server:hello"}')) {
      link().deliver({ type: 'frame', sessionId: SESSION, frame })
    }
    expect(hub.lines).toEqual(['{"jsonrpc":"2.0","id":1,"method":"server:hello"}\n'])

    const before = link().framesFor(SESSION).length
    hub.send!('{"jsonrpc":"2.0","id":1,"result":{}}\n')
    const answer = link().framesFor(SESSION).slice(before)
    // Only ciphertext reaches the relay.
    expect(answer.join('')).not.toContain('jsonrpc')
    expect(answer.map((frame) => channel.open(frame))).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{}}'
    ])
  })

  it('signs a paired device in again on a later session', () => {
    start()
    link().register()
    const identity = device()
    const offer = store.startPairing()
    const { deviceId } = handshake({ type: 'pair', name: 'iPhone', secret: offer.secret }, identity)
    link().deliver({ type: 'close', sessionId: SESSION })
    expect(hub.closed).toBe(1)
    expect(client!.connectedDevices()).toEqual([])
    // The relay's close needs no answer.
    expect(link().closeFor(SESSION)).toBeUndefined()

    handshake({ type: 'auth', deviceId: deviceId! }, identity, 'fedcba9876543210')
    expect(client!.connectedDevices()).toEqual([deviceId])
  })

  it('refuses protocol 1 over the relay without a plaintext answer', () => {
    start()
    link().register()
    link().deliver({ type: 'open', sessionId: SESSION })
    link().deliver({
      type: 'frame',
      sessionId: SESSION,
      frame: JSON.stringify({ type: 'hello', clientNonce: 'ab'.repeat(16) })
    })
    expect(link().framesFor(SESSION)).toEqual([])
    expect(link().closeFor(SESSION)).toBe(4401)
    expect(hub.send).toBeUndefined()
  })

  it('refuses an unknown device and a spent pairing code', () => {
    start()
    link().register()
    expect(() => handshake({ type: 'auth', deviceId: 'nobody' })).toThrow(/closed 4401/)
    expect(() =>
      handshake({ type: 'pair', name: 'x', secret: 'wrong' }, device(), 'fedcba9876543210')
    ).toThrow(/closed 4401/)
    expect(store.devices()).toEqual([])
  })

  it('ends a session whose frame was tampered with', () => {
    start()
    link().register()
    handshake({ type: 'pair', name: 'iPhone', secret: store.startPairing().secret })
    link().deliver({ type: 'frame', sessionId: SESSION, frame: 'AAAA' })
    expect(link().closeFor(SESSION)).toBe(4400)
    expect(hub.closed).toBe(1)
    expect(connections.at(-1)).toBe(0)
  })

  it('ends a revoked device at once, and one removed by another process at the next ping', () => {
    start()
    link().register()
    const { deviceId } = handshake({
      type: 'pair',
      name: 'iPhone',
      secret: store.startPairing().secret
    })
    store.revoke(deviceId!)
    expect(link().closeFor(SESSION)).toBe(4403)

    const other = createAccessStore({ path: join(dir, 'access.json'), now: () => Date.now() })
    const second = handshake(
      { type: 'pair', name: 'iPad', secret: store.startPairing().secret },
      device(),
      'fedcba9876543210'
    )
    other.reload()
    other.revoke(second.deviceId!)
    vi.advanceTimersByTime(1_000)
    expect(link().closeFor('fedcba9876543210')).toBe(4403)
  })

  it('closes a handshake that goes quiet, and caps handshakes at once', () => {
    start()
    link().register()
    link().deliver({ type: 'open', sessionId: SESSION })
    vi.advanceTimersByTime(5_000)
    expect(link().closeFor(SESSION)).toBe(4408)

    for (let i = 0; i < MAX_RELAY_HANDSHAKING + 1; i++) {
      link().deliver({ type: 'open', sessionId: i.toString(16).padStart(16, '0') })
    }
    const last = MAX_RELAY_HANDSHAKING.toString(16).padStart(16, '0')
    expect(link().closeFor(last)).toBe(4429)
    expect(client!.sessions()).toBe(MAX_RELAY_HANDSHAKING)
  })

  it('dials again with a growing delay, and says why', () => {
    start()
    link().events.error(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
    link().hangUp(1006)
    expect(statuses.at(-1)?.[0]).toBe('unreachable')
    expect(client!.error()).toMatch(/Nothing is listening at 100\.64\.0\.9:7879/)
    expect(links).toHaveLength(1)
    vi.advanceTimersByTime(1_000)
    expect(links).toHaveLength(2)
    link().hangUp(1006)
    vi.advanceTimersByTime(1_999)
    expect(links).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(links).toHaveLength(3)

    // A registration resets the delay.
    link().register()
    link().hangUp(1006)
    expect(client!.error()).toBe('The link to the relay dropped.')
    vi.advanceTimersByTime(1_000)
    expect(links).toHaveLength(4)
  })

  it('ends every session when the link drops', () => {
    start()
    link().register()
    handshake({ type: 'pair', name: 'iPhone', secret: store.startPairing().secret })
    link().hangUp(1006)
    expect(hub.closed).toBe(1)
    expect(client!.connectedDevices()).toEqual([])
    expect(connections.at(-1)).toBe(0)
  })

  it('says when the relay does not allow this computer, and keeps trying', () => {
    start()
    link().events.open()
    link().hangUp(RELAY_CLOSE.NOT_ALLOWED)
    expect(client!.status()).toBe('notAllowed')
    expect(client!.error()).toMatch(/styr relay allow/)
    vi.advanceTimersByTime(1_000)
    expect(links).toHaveLength(2)

    // The relay turns it away for a minute after several refusals: still "not allowed".
    link().events.error(Object.assign(new Error('HTTP 429'), { statusCode: 429 }))
    link().hangUp(1006)
    expect(client!.status()).toBe('notAllowed')
  })

  it('stops when another process with the same key takes over', () => {
    start()
    link().register()
    link().hangUp(RELAY_CLOSE.REPLACED)
    expect(client!.status()).toBe('replaced')
    vi.advanceTimersByTime(120_000)
    expect(links).toHaveLength(1)
  })

  it('drops a relay that breaks the protocol, and one that stops answering pings', () => {
    start()
    link().events.open()
    link().deliver({ type: 'open', sessionId: SESSION })
    expect(link().closedWith).toBe(4400)
    expect(client!.status()).toBe('unreachable')
    vi.advanceTimersByTime(1_000)

    link().register()
    link().deliver('not json')
    expect(link().closedWith).toBe(4400)
    vi.advanceTimersByTime(2_000)

    link().register()
    vi.advanceTimersByTime(1_000)
    expect(link().pings).toBe(1)
    vi.advanceTimersByTime(1_000)
    expect(link().terminated).toBe(true)
    link().hangUp(1006)
    expect(client!.error()).toBe('The relay stopped answering.')
  })

  it('stops dialling once closed', async () => {
    start()
    link().hangUp(1006)
    await client!.close()
    vi.advanceTimersByTime(120_000)
    expect(links).toHaveLength(1)
  })
})

describe('relay address', () => {
  it('takes loopback and Tailscale addresses only', () => {
    expect(relayAddressProblem('100.64.0.9')).toBeUndefined()
    expect(relayAddressProblem('127.0.0.1')).toBeUndefined()
    expect(relayAddressProblem('fd7a:115c:a1e0::1')).toBeUndefined()
    expect(relayAddressProblem('')).toMatch(/address/)
    expect(relayAddressProblem('192.168.1.5')).toMatch(/not a Tailscale or loopback/)
    expect(relayAddressProblem('8.8.8.8')).toMatch(/not a Tailscale or loopback/)
    expect(relayAddressProblem('relay.example.com')).toMatch(/not a Tailscale or loopback/)
  })

  it('brackets an IPv6 address in the URL', () => {
    expect(relayUrl('fd7a:115c:a1e0::1', 7879)).toBe('ws://[fd7a:115c:a1e0::1]:7879/host')
  })
})
