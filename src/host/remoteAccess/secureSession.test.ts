import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccessStore, type AccessStore } from './accessStore.js'
import { createServerHandshake } from './handshake.js'
import { NoiseXX, generateNoiseKeyPair } from './noise.js'
import {
  createSecureClientHandshake,
  SecureHandshakeError,
  type SecureClientOptions
} from './secureClient.js'
import {
  NOISE_PROLOGUE,
  RECORD_CHUNK_BYTES,
  SecureChannelError,
  SecureFrameChannel,
  createConnectionHandshake,
  createSecureServerHandshake,
  decodeFrame,
  type SecureHandshakeResult
} from './secureSession.js'

const MAX = 8 * 1024 * 1024

function deviceIdentity(): { privateKey: KeyObject; publicKey: string } {
  const pair = generateKeyPairSync('ed25519')
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  }
}

/** Ties a client and a server handshake together, frame by frame, as a socket would. */
function run(
  server: ReturnType<typeof createSecureServerHandshake>,
  client: ReturnType<typeof createSecureClientHandshake>,
  /** What the path does to each client frame on the way (a relay that tampers). */
  path: (frame: string, index: number) => string = (frame) => frame
) {
  const toServer: string[] = [client.start()]
  let index = 0
  let last: SecureHandshakeResult | undefined
  while (toServer.length > 0) {
    last = server.receive(path(toServer.shift()!, index++))
    if (last.kind === 'denied') return { server: last }
    for (const frame of last.frames) {
      const step = client.receive(frame)
      if (step.kind === 'send') toServer.push(...step.frames)
      if (step.kind === 'ready') return { server: last, client: step }
    }
  }
  return { server: last! }
}

const flip = (frame: string, at = 40): string => {
  const bytes = decodeFrame(frame)
  bytes[at % bytes.length]! ^= 1
  return bytes.toString('base64')
}

describe('protocol 2 (Noise XX with identity binding)', () => {
  let dir: string
  let store: AccessStore
  const fingerprint = () => store.identity().fingerprint
  const server = () => createSecureServerHandshake({ store, maxMessageBytes: MAX })
  const client = (options: Partial<SecureClientOptions> & Pick<SecureClientOptions, 'signIn'>) =>
    createSecureClientHandshake({
      pinnedFingerprint: fingerprint(),
      identity: options.identity ?? deviceIdentity(),
      maxMessageBytes: MAX,
      ...options
    })

  async function pair(identity = deviceIdentity()) {
    const offer = store.startPairing()
    const result = run(
      server(),
      client({ identity, signIn: { type: 'pair', name: 'iPhone', secret: offer.secret } })
    )
    return { identity, result }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'styr-noise-'))
    store = createAccessStore({ path: join(dir, 'access.json'), now: () => 1_000_000 })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('pairs with the QR secret, then signs in with the device key alone', async () => {
    const { identity, result } = await pair()
    expect(result.server.kind).toBe('ready')
    const deviceId = result.client!.deviceId!
    expect(store.devices().map((device) => device.id)).toEqual([deviceId])
    expect(store.publicKeyFor(deviceId)).toBe(identity.publicKey)

    const again = run(server(), client({ identity, signIn: { type: 'auth', deviceId } }))
    expect(again.server).toMatchObject({ kind: 'ready', deviceId, paired: false })
    expect(again.client?.kind).toBe('ready')
  })

  it('carries messages both ways, splitting the large ones into records', async () => {
    const { result } = await pair()
    const host = (result.server as Extract<SecureHandshakeResult, { kind: 'ready' }>).channel
    const phone = result.client!.channel
    expect(host.handshakeHash.equals(phone.handshakeHash)).toBe(true)
    const big = 'é'.repeat(200_000)
    const frames = phone.seal(big)
    expect(frames.length).toBeGreaterThan(1)
    const opened = frames.map((frame) => host.open(frame))
    expect(opened.slice(0, -1).every((part) => part === undefined)).toBe(true)
    expect(opened.at(-1)).toBe(big)
    expect(phone.open(host.seal('{"id":1}')[0]!)).toBe('{"id":1}')
    expect(phone.open(host.seal('')[0]!)).toBe('')
  })

  describe('a path that tampers ends the session', () => {
    async function channels() {
      const { result } = await pair()
      return {
        host: (result.server as Extract<SecureHandshakeResult, { kind: 'ready' }>).channel,
        phone: result.client!.channel
      }
    }

    it('refuses an altered frame, and everything after it', async () => {
      const { host, phone } = await channels()
      const [frame] = phone.seal('{"method":"terminal:write"}')
      expect(() => host.open(flip(frame!))).toThrow(SecureChannelError)
      expect(() => host.open(frame!)).toThrow(SecureChannelError)
    })

    it('refuses a replayed frame', async () => {
      const { host, phone } = await channels()
      const [frame] = phone.seal('one')
      expect(host.open(frame!)).toBe('one')
      expect(() => host.open(frame!)).toThrow(SecureChannelError)
    })

    it('refuses frames out of order', async () => {
      const { host, phone } = await channels()
      const [first] = phone.seal('one')
      const [second] = phone.seal('two')
      expect(() => host.open(second!)).toThrow(SecureChannelError)
      expect(() => host.open(first!)).toThrow(SecureChannelError)
    })

    it('notices a dropped frame at the next one', async () => {
      const { host, phone } = await channels()
      phone.seal('dropped')
      const [next] = phone.seal('next')
      expect(() => host.open(next!)).toThrow(SecureChannelError)
    })

    it('refuses a frame sealed for the other direction', async () => {
      const { host } = await channels()
      const [own] = host.seal('mine')
      expect(() => host.open(own!)).toThrow(SecureChannelError)
    })

    it('refuses frames that are not strict base64', async () => {
      const { host, phone } = await channels()
      const [frame] = phone.seal('x')
      expect(() => host.open(`${frame} `)).toThrow(SecureChannelError)
    })
  })

  describe('records', () => {
    /** One end as a raw Noise transport, to send records the channel itself never makes. */
    function rawPair(maxMessageBytes = MAX) {
      const a = new NoiseXX({ initiator: true, staticKey: generateNoiseKeyPair() })
      const b = new NoiseXX({ initiator: false, staticKey: generateNoiseKeyPair() })
      b.read(a.write())
      a.read(b.write())
      b.read(a.write())
      return {
        raw: a.transport(),
        channel: new SecureFrameChannel(b.transport(), maxMessageBytes)
      }
    }
    const record = (flag: number, body: Buffer) => Buffer.concat([Buffer.from([flag]), body])

    it('refuses a non-final record shorter than a full chunk', () => {
      const { raw, channel } = rawPair()
      const frame = raw.send.encrypt(record(0, Buffer.from('crumb'))).toString('base64')
      expect(() => channel.open(frame)).toThrow(/short record/)
    })

    it('refuses an unknown flag and an empty record', () => {
      const one = rawPair()
      expect(() =>
        one.channel.open(one.raw.send.encrypt(record(2, Buffer.from('x'))).toString('base64'))
      ).toThrow(/flag/)
      const two = rawPair()
      expect(() =>
        two.channel.open(two.raw.send.encrypt(Buffer.alloc(0)).toString('base64'))
      ).toThrow(SecureChannelError)
    })

    it('stops reassembling past the size limit', () => {
      const { raw, channel } = rawPair(RECORD_CHUNK_BYTES + 10)
      const full = raw.send.encrypt(record(0, Buffer.alloc(RECORD_CHUNK_BYTES, 97)))
      expect(channel.open(full.toString('base64'))).toBeUndefined()
      const over = raw.send.encrypt(record(1, Buffer.alloc(11, 97)))
      expect(() => channel.open(over.toString('base64'))).toThrow(/too large/)
    })

    it('refuses a message that is not UTF-8', () => {
      const { raw, channel } = rawPair()
      const frame = raw.send.encrypt(record(1, Buffer.from([0xff, 0xfe]))).toString('base64')
      expect(() => channel.open(frame)).toThrow(SecureChannelError)
    })
  })

  describe('identity', () => {
    it('stops at the wrong host before sending anything about the device', () => {
      const offer = store.startPairing()
      const phone = createSecureClientHandshake({
        pinnedFingerprint: 'a'.repeat(64),
        identity: deviceIdentity(),
        signIn: { type: 'pair', name: 'iPhone', secret: offer.secret },
        maxMessageBytes: MAX
      })
      const host = server()
      const reply = host.receive(phone.start())
      expect(reply.kind).toBe('reply')
      expect(() => phone.receive(reply.frames[0]!)).toThrow(SecureHandshakeError)
      // The offer was never spent: nothing reached the host.
      expect(store.pairing()).toBeDefined()
    })

    it("refuses a relay that answers with its own Noise key and the real host's signature", () => {
      // The relay opens a session with the host as a client and reads the host's genuine payload…
      const toHost = new NoiseXX({
        initiator: true,
        staticKey: generateNoiseKeyPair(),
        prologue: NOISE_PROLOGUE
      })
      const host = server()
      const hostReply = host.receive(
        JSON.stringify({ type: 'hello', protocol: 2, noise: toHost.write().toString('base64') })
      )
      const genuine = toHost.read(decodeFrame(hostReply.frames[0]!)).payload
      // …then answers the phone in its own session with it. The signature covers the host's
      // static key and the relay<->host hash, neither of which the phone sees.
      const relay = new NoiseXX({
        initiator: false,
        staticKey: generateNoiseKeyPair(),
        prologue: NOISE_PROLOGUE
      })
      const phone = client({ signIn: { type: 'auth', deviceId: 'x' } })
      relay.read(decodeFrame(JSON.parse(phone.start()).noise))
      expect(() => phone.receive(relay.write(genuine).toString('base64'))).toThrow(
        /not the one this device paired with/
      )
    })

    it('refuses an unknown device and a device whose key does not match', async () => {
      const unknown = run(server(), client({ signIn: { type: 'auth', deviceId: 'nobody' } }))
      expect(unknown.server).toMatchObject({ kind: 'denied', reason: 'bad device signature' })

      const { result } = await pair()
      const deviceId = result.client!.deviceId!
      const stolenId = run(server(), client({ signIn: { type: 'auth', deviceId } }))
      expect(stolenId.server).toMatchObject({ kind: 'denied', reason: 'bad device signature' })
    })

    it('refuses a revoked device', async () => {
      const { identity, result } = await pair()
      const deviceId = result.client!.deviceId!
      store.revoke(deviceId)
      const after = run(server(), client({ identity, signIn: { type: 'auth', deviceId } }))
      expect(after.server.kind).toBe('denied')
    })
  })

  describe('pairing', () => {
    it('refuses a wrong secret and spends the offer', () => {
      store.startPairing()
      const result = run(
        server(),
        client({ signIn: { type: 'pair', name: 'iPhone', secret: 'guess' } })
      )
      expect(result.server).toMatchObject({ kind: 'denied', reason: 'bad pairing proof' })
      expect(store.pairing()).toBeUndefined()
      expect(store.devices()).toEqual([])
    })

    it('a relay cannot pair: a proof made for one session fails in another', () => {
      // The relay sits between the phone and the host, running a handshake with each. Whatever it
      // forwards was made over the phone<->relay hash, so the host's check fails.
      const offer = store.startPairing()
      const phoneIdentity = deviceIdentity()
      const relayAsHost = createSecureServerHandshake({
        // The relay pretends to be a host whose fingerprint the phone pinned: it is not, so a
        // real phone stops at message 2. Here the relay's own store stands in, to get message 3.
        store: {
          ...store,
          identity: () => store.identity(),
          consumePairing: () => offer,
          addDevice: () => ({ id: 'relay', name: '', createdAt: '' })
        },
        maxMessageBytes: MAX
      })
      const phone = client({
        identity: phoneIdentity,
        signIn: { type: 'pair', name: 'iPhone', secret: offer.secret }
      })
      // Message 3 as the phone wrote it for the relay's session.
      const toRelay = relayAsHost.receive(phone.start())
      const step = phone.receive(toRelay.frames[0]!)
      const phoneFinal = step.kind === 'send' ? step.frames[0]! : ''

      // The relay now opens its own session with the host and sends the captured message 3.
      const host = server()
      const relayClient = createSecureClientHandshake({
        pinnedFingerprint: fingerprint(),
        identity: deviceIdentity(),
        signIn: { type: 'auth', deviceId: 'x' },
        maxMessageBytes: MAX
      })
      const hostReply = host.receive(relayClient.start())
      relayClient.receive(hostReply.frames[0]!)
      const outcome = host.receive(phoneFinal)
      expect(outcome.kind).toBe('denied')
      expect(store.devices()).toEqual([])
    })

    it('refuses a pairing whose signature is not by the key it names', () => {
      const offer = store.startPairing()
      const someoneElse = deviceIdentity()
      const result = run(
        server(),
        client({
          // Signs with one key and names another: possession of the named key is not shown.
          identity: { privateKey: deviceIdentity().privateKey, publicKey: someoneElse.publicKey },
          signIn: { type: 'pair', name: 'iPhone', secret: offer.secret }
        })
      )
      expect(result.server).toMatchObject({ kind: 'denied', reason: 'bad device signature' })
      expect(store.devices()).toEqual([])
    })
  })

  describe('handshake frames', () => {
    it('refuses an altered message 3, and a message 3 replayed into a new session', async () => {
      const { identity, result } = await pair()
      const deviceId = result.client!.deviceId!
      const tampered = run(
        server(),
        client({ identity, signIn: { type: 'auth', deviceId } }),
        (frame, index) => (index === 1 ? flip(frame) : frame)
      )
      expect(tampered.server.kind).toBe('denied')

      let captured = ''
      run(server(), client({ identity, signIn: { type: 'auth', deviceId } }), (frame, index) => {
        if (index === 1) captured = frame
        return frame
      })
      const fresh = server()
      fresh.receive(client({ identity, signIn: { type: 'auth', deviceId } }).start())
      expect(fresh.receive(captured).kind).toBe('denied')
    })

    it('refuses a payload in message 1 and anything after the end', () => {
      const host = server()
      const noise = new NoiseXX({
        initiator: true,
        staticKey: generateNoiseKeyPair(),
        prologue: NOISE_PROLOGUE
      })
      const first = noise.write(Buffer.from('hi')).toString('base64')
      expect(
        host.receive(JSON.stringify({ type: 'hello', protocol: 2, noise: first }))
      ).toMatchObject({ kind: 'denied' })
      expect(host.receive('{}').kind).toBe('denied')
    })

    it('refuses a host whose payload is not JSON', () => {
      const relay = new NoiseXX({
        initiator: false,
        staticKey: generateNoiseKeyPair(),
        prologue: NOISE_PROLOGUE
      })
      const phone = client({ signIn: { type: 'auth', deviceId: 'x' } })
      relay.read(decodeFrame(JSON.parse(phone.start()).noise))
      expect(() => phone.receive(relay.write(Buffer.from('nope')).toString('base64'))).toThrow(
        SecureHandshakeError
      )
    })
  })

  describe('choosing the protocol', () => {
    const connection = (secure: 'off' | 'allow' | 'require') =>
      createConnectionHandshake({
        secure,
        protocol: 1,
        plain: () => createServerHandshake({ store, protocol: 1 }),
        secureHandshake: server
      })
    const plainHello = JSON.stringify({ type: 'hello', protocol: 1, clientNonce: 'a'.repeat(32) })
    const secureHello = () => client({ signIn: { type: 'auth', deviceId: 'x' } }).start()

    it('off: direct mode answers protocol 1 as before, and protocol 2 with its protocol error', () => {
      expect(JSON.parse(connection('off').receive(plainHello).frames[0]!).type).toBe('challenge')
      const refused = connection('off').receive(secureHello())
      expect(refused.kind).toBe('denied')
      expect(JSON.parse(refused.frames[0]!)).toEqual({
        type: 'error',
        code: 'protocol',
        protocol: 1
      })
    })

    it('allow: either, as the client picks', () => {
      expect(connection('allow').receive(plainHello).kind).toBe('reply')
      const reply = connection('allow').receive(secureHello())
      expect(reply.kind).toBe('reply')
      expect(() => decodeFrame(reply.frames[0]!)).not.toThrow()
    })

    it('require: no downgrade, protocol 1 is refused without a plaintext byte', () => {
      const refused = connection('require').receive(plainHello)
      expect(refused).toMatchObject({ kind: 'denied', frames: [] })
      expect(connection('require').receive('{"type":"hello"}').kind).toBe('denied')
    })
  })
})
