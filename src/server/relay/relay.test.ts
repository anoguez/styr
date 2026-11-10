import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createAccessStore } from '@host/remoteAccess/accessStore.js'
import { fingerprintOf } from '@host/remoteAccess/handshake.js'
import { createSecureClientHandshake } from '@host/remoteAccess/secureClient.js'
import {
  createSecureServerHandshake,
  type SecureFrameChannel
} from '@host/remoteAccess/secureSession.js'
import {
  RELAY_CLOSE,
  RELAY_FRAME_MAX_CHARS,
  relayRegistrationData,
  type RelayToHost
} from '@host/remoteAccess/relayProtocol.js'
import { createAllowList, type AllowList } from './allowList.js'
import { startRelay, type Relay, type RelayOptions } from './relay.js'

/** One end of a WebSocket to the relay, with what it received queued in order. */
class Endpoint {
  readonly socket: WebSocket
  readonly messages: string[] = []
  private waiting: ((text: string | undefined) => void)[] = []
  closed?: { code: number; reason: string }
  readonly opened: Promise<void>

  constructor(port: number, path: string, headers?: Record<string, string>) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
    this.socket.on('message', (data) => {
      const text = data.toString()
      const waiter = this.waiting.shift()
      if (waiter) waiter(text)
      else this.messages.push(text)
    })
    this.socket.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() }
      for (const waiter of this.waiting.splice(0)) waiter(undefined)
    })
    this.socket.on('error', () => undefined)
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve())
      this.socket.once('unexpected-response', (_request, response) =>
        reject(new Error(`HTTP ${response.statusCode}`))
      )
      this.socket.once('error', reject)
    })
  }

  next(): Promise<string | undefined> {
    const queued = this.messages.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.closed) return Promise.resolve(undefined)
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  async json(): Promise<RelayToHost> {
    const text = await this.next()
    if (text === undefined) throw new Error(`closed ${JSON.stringify(this.closed)}`)
    return JSON.parse(text) as RelayToHost
  }

  send(value: unknown): void {
    this.socket.send(typeof value === 'string' ? value : JSON.stringify(value))
  }

  async waitClosed(): Promise<{ code: number; reason: string }> {
    while (!this.closed) await new Promise((resolve) => setTimeout(resolve, 5))
    return this.closed
  }

  close(): void {
    this.socket.close()
  }
}

function hostIdentity() {
  const pair = generateKeyPairSync('ed25519')
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  return { privateKey: pair.privateKey, publicKey, fingerprint: fingerprintOf(publicKey) }
}

type HostIdentity = ReturnType<typeof hostIdentity>

const registration = (key: KeyObject, publicKey: string, nonce: string) => ({
  type: 'register',
  hostKey: publicKey,
  signature: sign(null, Buffer.from(relayRegistrationData(nonce)), key).toString('base64')
})

describe('styr relay', () => {
  let dir: string
  let allowList: AllowList
  let relay: Relay
  let log: string[]
  const endpoints: Endpoint[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'styr-relay-'))
    allowList = createAllowList(join(dir, 'relay.json'))
    log = []
  })

  afterEach(async () => {
    for (const endpoint of endpoints.splice(0)) endpoint.socket.terminate()
    await relay?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function start(options: Partial<RelayOptions> = {}): Promise<void> {
    relay = await startRelay(
      { allowList, log: (line) => log.push(line), limitLoopback: true, ...options },
      '127.0.0.1',
      0
    )
  }

  function endpoint(path: string, headers?: Record<string, string>): Endpoint {
    const created = new Endpoint(relay.address.port, path, headers)
    endpoints.push(created)
    return created
  }

  /** A host that answered the challenge with its own key; its `registered` is consumed. */
  async function host(identity: HostIdentity): Promise<Endpoint> {
    const socket = endpoint('/host')
    const challenge = (await socket.json()) as unknown as { nonce: string }
    socket.send(registration(identity.privateKey, identity.publicKey, challenge.nonce))
    expect(await socket.json()).toEqual({ type: 'registered' })
    return socket
  }

  /** A phone with an open session; the host's `open` is consumed and its id returned. */
  async function phone(hostSocket: Endpoint, identity: HostIdentity) {
    const socket = endpoint(`/phone/${identity.fingerprint}`)
    await socket.opened
    const open = await hostSocket.json()
    expect(open.type).toBe('open')
    return { socket, sessionId: (open as { sessionId: string }).sessionId }
  }

  it('forwards frames both ways without reading them', async () => {
    await start()
    const identity = hostIdentity()
    allowList.allow(identity.fingerprint)
    const hostSocket = await host(identity)
    const { socket, sessionId } = await phone(hostSocket, identity)

    socket.send('not even JSON {')
    expect(await hostSocket.json()).toEqual({ type: 'frame', sessionId, frame: 'not even JSON {' })
    hostSocket.send({ type: 'frame', sessionId, frame: 'answer' })
    expect(await socket.next()).toBe('answer')
    expect(relay.hosts()).toEqual([{ fingerprint: identity.fingerprint, sessions: 1 }])

    // Two phones are two sessions on the host's one socket, kept apart.
    const second = await phone(hostSocket, identity)
    expect(second.sessionId).not.toBe(sessionId)
    hostSocket.send({ type: 'frame', sessionId: second.sessionId, frame: 'to the second' })
    expect(await second.socket.next()).toBe('to the second')
    expect(socket.messages).toEqual([])
  })

  it('tells the host when a phone hangs up, and passes the host close code to the phone', async () => {
    await start()
    const identity = hostIdentity()
    allowList.allow(identity.fingerprint)
    const hostSocket = await host(identity)
    const first = await phone(hostSocket, identity)
    first.socket.close()
    expect(await hostSocket.json()).toEqual({ type: 'close', sessionId: first.sessionId })

    const second = await phone(hostSocket, identity)
    hostSocket.send({ type: 'close', sessionId: second.sessionId, code: 4401 })
    expect((await second.socket.waitClosed()).code).toBe(4401)
    expect(relay.hosts()[0]!.sessions).toBe(0)
  })

  it('a phone asking for an offline, unknown or not-allowed host learns only 4404', async () => {
    await start()
    const allowed = hostIdentity()
    const notAllowed = hostIdentity()
    allowList.allow(allowed.fingerprint)
    // Not allowed, but tries: refused, so it never becomes reachable.
    const intruder = endpoint('/host')
    const challenge = (await intruder.json()) as unknown as { nonce: string }
    intruder.send(registration(notAllowed.privateKey, notAllowed.publicKey, challenge.nonce))
    expect((await intruder.waitClosed()).code).toBe(RELAY_CLOSE.NOT_ALLOWED)

    const answers = []
    for (const fingerprint of [allowed.fingerprint, notAllowed.fingerprint, 'a'.repeat(64)]) {
      const socket = endpoint(`/phone/${fingerprint}`)
      await socket.opened
      answers.push({ closed: await socket.waitClosed(), messages: socket.messages })
    }
    expect(answers).toEqual(
      Array(3).fill({
        closed: { code: RELAY_CLOSE.HOST_OFFLINE, reason: 'host offline' },
        messages: []
      })
    )
  })

  it('a host gone offline ends its sessions with 4404', async () => {
    await start()
    const identity = hostIdentity()
    allowList.allow(identity.fingerprint)
    const hostSocket = await host(identity)
    const { socket } = await phone(hostSocket, identity)
    hostSocket.socket.terminate()
    expect((await socket.waitClosed()).code).toBe(RELAY_CLOSE.HOST_OFFLINE)
    expect(relay.hosts()).toEqual([])
  })

  it('refuses a signature over another nonce, or by another key', async () => {
    await start()
    const identity = hostIdentity()
    const other = hostIdentity()
    allowList.allow(identity.fingerprint)

    const replayed = endpoint('/host')
    await replayed.json()
    replayed.send(registration(identity.privateKey, identity.publicKey, 'b'.repeat(32)))
    expect((await replayed.waitClosed()).code).toBe(RELAY_CLOSE.UNAUTHORIZED)

    const forged = endpoint('/host')
    const challenge = (await forged.json()) as unknown as { nonce: string }
    forged.send(registration(other.privateKey, identity.publicKey, challenge.nonce))
    expect((await forged.waitClosed()).code).toBe(RELAY_CLOSE.UNAUTHORIZED)
    expect(relay.hosts()).toEqual([])
  })

  it('a second registration of the same key takes over', async () => {
    await start()
    const identity = hostIdentity()
    allowList.allow(identity.fingerprint)
    const first = await host(identity)
    const { socket } = await phone(first, identity)
    const second = await host(identity)
    expect((await first.waitClosed()).code).toBe(RELAY_CLOSE.REPLACED)
    expect((await socket.waitClosed()).code).toBe(RELAY_CLOSE.HOST_OFFLINE)
    await phone(second, identity)
  })

  it('a revoked host is cut off with its sessions', async () => {
    await start()
    const identity = hostIdentity()
    allowList.allow(identity.fingerprint)
    const hostSocket = await host(identity)
    const { socket } = await phone(hostSocket, identity)
    allowList.revoke(identity.fingerprint)
    relay.disconnectHost(identity.fingerprint)
    expect((await hostSocket.waitClosed()).code).toBe(RELAY_CLOSE.NOT_ALLOWED)
    expect((await socket.waitClosed()).code).toBe(RELAY_CLOSE.HOST_OFFLINE)

    const again = endpoint('/host')
    const challenge = (await again.json()) as unknown as { nonce: string }
    again.send(registration(identity.privateKey, identity.publicKey, challenge.nonce))
    expect((await again.waitClosed()).code).toBe(RELAY_CLOSE.NOT_ALLOWED)
  })

  it('ends a session on a binary or oversized phone frame, and a host on a bad message', async () => {
    await start()
    const identity = hostIdentity()
    allowList.allow(identity.fingerprint)
    const hostSocket = await host(identity)

    const binary = await phone(hostSocket, identity)
    binary.socket.socket.send(Buffer.from([1, 2, 3]))
    expect((await binary.socket.waitClosed()).code).toBe(RELAY_CLOSE.BAD_REQUEST)
    expect(await hostSocket.json()).toEqual({ type: 'close', sessionId: binary.sessionId })

    const large = await phone(hostSocket, identity)
    large.socket.send('x'.repeat(RELAY_FRAME_MAX_CHARS + 1))
    expect((await large.socket.waitClosed()).code).toBe(1009)
    expect(await hostSocket.json()).toEqual({ type: 'close', sessionId: large.sessionId })

    const kept = await phone(hostSocket, identity)
    hostSocket.send({ type: 'frame', sessionId: kept.sessionId })
    expect((await hostSocket.waitClosed()).code).toBe(RELAY_CLOSE.BAD_REQUEST)
    expect((await kept.socket.waitClosed()).code).toBe(RELAY_CLOSE.HOST_OFFLINE)
  })

  it('times out a host that does not register', async () => {
    await start({ registerMs: 50 })
    const socket = endpoint('/host')
    await socket.json()
    expect((await socket.waitClosed()).code).toBe(RELAY_CLOSE.TIMEOUT)
  })

  it('turns an address away after five failed registrations', async () => {
    await start()
    for (let i = 0; i < 5; i++) {
      const socket = endpoint('/host')
      await socket.json()
      socket.send({ type: 'register', hostKey: 'x', signature: 'y' })
      await socket.waitClosed()
    }
    await expect(endpoint('/host').opened).rejects.toThrow('HTTP 429')
    expect(log.at(-1)).toContain('too many failed attempts')
  })

  it('refuses unknown paths, proxies and browser origins', async () => {
    await start()
    await expect(endpoint('/').opened).rejects.toThrow('HTTP 404')
    await expect(endpoint('/phone/not-a-fingerprint').opened).rejects.toThrow('HTTP 404')
    await expect(endpoint('/host', { 'x-forwarded-for': '8.8.8.8' }).opened).rejects.toThrow(
      'HTTP 400'
    )
    await expect(endpoint('/host', { origin: 'https://example.com' }).opened).rejects.toThrow(
      'HTTP 403'
    )
  })

  it('binds only to loopback or Tailscale', async () => {
    const options = { allowList, log: () => undefined }
    await expect(startRelay(options, '0.0.0.0', 0)).rejects.toThrow('every interface')
    await expect(startRelay(options, '192.168.1.5', 0)).rejects.toThrow('not a Tailscale')
    await expect(startRelay(options, '8.8.8.8', 0)).rejects.toThrow('not a Tailscale')
  })

  it('ends a session that falls too far behind toward its host, and only that one', async () => {
    await start({ maxSessionBufferedBytes: 64 * 1024 })
    const identity = hostIdentity()
    allowList.allow(identity.fingerprint)
    const hostSocket = await host(identity)
    const { socket, sessionId } = await phone(hostSocket, identity)
    // The host stops reading: the relay's writes to it stop completing.
    ;(hostSocket.socket as unknown as { _socket: { pause(): void } })._socket.pause()
    const chunk = 'x'.repeat(60_000)
    for (let i = 0; i < 400 && !socket.closed; i++) {
      socket.send(chunk)
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect((await socket.waitClosed()).code).toBe(RELAY_CLOSE.BUSY)
    ;(hostSocket.socket as unknown as { _socket: { resume(): void } })._socket.resume()
    for (;;) {
      const message = await hostSocket.json()
      if (message.type === 'close') {
        expect(message.sessionId).toBe(sessionId)
        break
      }
    }
    expect(hostSocket.closed).toBeUndefined()
  })

  it('carries a protocol-2 session end to end, and sees only ciphertext', async () => {
    await start()
    const store = createAccessStore({ path: join(dir, 'remote-access.json'), now: () => 1 })
    const identity = store.identity()
    allowList.allow(identity.fingerprint)

    // The host's half: register with its key, then run protocol 2 for the session.
    const hostSocket = endpoint('/host')
    const challenge = (await hostSocket.json()) as unknown as { nonce: string }
    hostSocket.send({
      type: 'register',
      hostKey: identity.publicKey,
      signature: identity.sign(relayRegistrationData(challenge.nonce))
    })
    expect(await hostSocket.json()).toEqual({ type: 'registered' })

    const offer = store.startPairing()
    const device = generateKeyPairSync('ed25519')
    const client = createSecureClientHandshake({
      pinnedFingerprint: identity.fingerprint,
      identity: {
        privateKey: device.privateKey,
        publicKey: device.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
      },
      signIn: { type: 'pair', name: 'iPhone', secret: offer.secret },
      maxMessageBytes: 1024 * 1024
    })
    const phoneSocket = endpoint(`/phone/${identity.fingerprint}`)
    await phoneSocket.opened
    const open = (await hostSocket.json()) as { sessionId: string }
    const server = createSecureServerHandshake({ store, maxMessageBytes: 1024 * 1024 })
    const seen: string[] = []

    phoneSocket.send(client.start())
    let hostChannel: SecureFrameChannel | undefined
    let phoneChannel: SecureFrameChannel | undefined
    while (!hostChannel || !phoneChannel) {
      if (!hostChannel) {
        const message = await hostSocket.json()
        if (message.type !== 'frame') throw new Error(`unexpected ${message.type}`)
        seen.push(message.frame)
        const outcome = server.receive(message.frame)
        for (const frame of outcome.frames) {
          hostSocket.send({ type: 'frame', sessionId: open.sessionId, frame })
        }
        if (outcome.kind === 'denied') throw new Error(outcome.reason)
        if (outcome.kind === 'ready') hostChannel = outcome.channel
      }
      if (!phoneChannel) {
        const frame = (await phoneSocket.next())!
        const step = client.receive(frame)
        if (step.kind === 'send') for (const out of step.frames) phoneSocket.send(out)
        if (step.kind === 'ready') phoneChannel = step.channel
      }
    }

    for (const frame of phoneChannel.seal('{"secret":"terminal input"}')) phoneSocket.send(frame)
    const sealed = await hostSocket.json()
    if (sealed.type !== 'frame') throw new Error('expected a frame')
    seen.push(sealed.frame)
    expect(hostChannel.open(sealed.frame)).toBe('{"secret":"terminal input"}')
    expect(seen.join('\n')).not.toContain('terminal input')
    expect(seen.join('\n')).not.toContain('iPhone')
  })
})
