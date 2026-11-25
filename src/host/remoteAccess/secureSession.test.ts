import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccessStore, type AccessStore } from './accessStore.js'
import { NoiseXX, generateNoiseKeyPair } from './noise.js'
import {
  createSecureClientHandshake,
  SecureHandshakeError,
  type SecureClientOptions
} from './secureClient.js'
import {
  NOISE_PROLOGUE,
  RECORD_CHUNK_BYTES,
  approvalCode,
  approvalCommit,
  identitySignedData,
  SecureChannelError,
  SecureFrameChannel,
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
  const server = () =>
    createSecureServerHandshake({ store, maxMessageBytes: MAX, acceptsRequests: true })
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

    it('refuses an empty final record after a split', () => {
      const { raw, channel } = rawPair()
      const full = raw.send.encrypt(record(0, Buffer.alloc(RECORD_CHUNK_BYTES, 97)))
      expect(channel.open(full.toString('base64'))).toBeUndefined()
      const empty = raw.send.encrypt(record(1, Buffer.alloc(0)))
      expect(() => channel.open(empty.toString('base64'))).toThrow(/empty final/)
    })

    it('splits a message of exactly one chunk into one record', () => {
      const { raw, channel } = rawPair()
      const frame = raw.send.encrypt(record(1, Buffer.alloc(RECORD_CHUNK_BYTES, 97)))
      expect(channel.open(frame.toString('base64'))).toHaveLength(RECORD_CHUNK_BYTES)
    })

    it('drops a leading byte-order mark, as the Dart client does', () => {
      const { raw, channel } = rawPair()
      const frame = raw.send.encrypt(record(1, Buffer.from('\uFEFF{}'))).toString('base64')
      expect(channel.open(frame)).toBe('{}')
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

    it('pairs with the longest name, of any characters, inside the handshake limit', () => {
      const offer = store.startPairing()
      const result = run(
        server(),
        client({ signIn: { type: 'pair', name: '\u0001🙂'.repeat(50), secret: offer.secret } })
      )
      expect(result.server.kind).toBe('ready')
    })

    it('refuses a name over the limit', () => {
      const offer = store.startPairing()
      const result = run(
        server(),
        client({ signIn: { type: 'pair', name: 'x'.repeat(101), secret: offer.secret } })
      )
      expect(result.server).toMatchObject({
        kind: 'denied',
        reason: 'expected auth, pair or request'
      })
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

  describe('pairing by approval (request)', () => {
    /** A device that found the host on the network: it has no fingerprint to pin. */
    const requester = (identity = deviceIdentity(), name = 'Pixel 9') =>
      createSecureClientHandshake({
        identity,
        signIn: { type: 'request', name },
        maxMessageBytes: MAX
      })

    /**
     * Runs the handshake up to the host's question: message 3 (with the commitment), the host's
     * random value, the device's reveal. What each side has then.
     */
    function ask(host = server(), device = requester()) {
      const reply = host.receive(device.start())
      const third = device.receive(reply.frames[0]!)
      if (third.kind !== 'send') throw new Error('expected message 3')
      const nonce = host.receive(third.frames[0]!)
      if (nonce.kind !== 'reply') return { host, device, step: undefined, outcome: nonce }
      const step = device.receive(nonce.frames[0]!)
      if (step.kind !== 'send') throw new Error('expected the reveal')
      const outcome = host.receive(step.frames[0]!)
      return { host, device, step, outcome }
    }

    it('is refused while no Add device window is open, before anyone is asked', () => {
      const { outcome } = ask()
      expect(outcome).toMatchObject({
        kind: 'denied',
        reason: 'not accepting pairing requests now'
      })
    })

    it('shows the same code on both screens, and pairs once allowed', () => {
      store.startPairing()
      const identity = deviceIdentity()
      const { device, step, outcome } = ask(server(), requester(identity))
      if (outcome.kind !== 'approval') throw new Error(`expected approval, got ${outcome.kind}`)
      expect(outcome).toMatchObject({ name: 'Pixel 9', frames: [] })
      expect(outcome.code).toMatch(/^\d{6}$/)
      expect(step!.approval).toEqual({ code: outcome.code, hostFingerprint: fingerprint() })
      // Nothing is added, and nothing sent, before the answer.
      expect(store.devices()).toEqual([])

      const answered = outcome.decide(true)
      if (answered.kind !== 'ready') throw new Error(`expected ready, got ${answered.kind}`)
      let ready: ReturnType<typeof device.receive> | undefined
      for (const frame of answered.frames) ready = device.receive(frame)
      expect(ready).toMatchObject({ kind: 'ready', deviceId: answered.deviceId })
      expect(store.publicKeyFor(answered.deviceId)).toBe(identity.publicKey)
      // One answer per window: the offer is spent.
      expect(store.pairing()).toBeUndefined()

      // The device then signs in with its own key, pinned to the host it was shown.
      const again = run(
        server(),
        client({ identity, signIn: { type: 'auth', deviceId: answered.deviceId } })
      )
      expect(again.server.kind).toBe('ready')
    })

    it('shows no code before both random values are in', () => {
      store.startPairing()
      const host = server()
      const device = requester()
      const third = device.receive(host.receive(device.start()).frames[0]!)
      // Message 3 carries only the commitment: no code yet on either side.
      expect(third).toMatchObject({ kind: 'send' })
      expect((third as { approval?: unknown }).approval).toBeUndefined()
      expect(host.receive((third as { frames: string[] }).frames[0]!).kind).toBe('reply')
    })

    it('refuses a device that reveals another value than it committed to', () => {
      // A device built by hand, as an attacker would: it commits to one value in message 3 and,
      // having seen the host's, reveals another chosen to steer the code.
      store.startPairing()
      const host = server()
      const identity = deviceIdentity()
      const staticKey = generateNoiseKeyPair()
      const noise = new NoiseXX({ initiator: true, staticKey, prologue: NOISE_PROLOGUE })
      const hello = JSON.stringify({
        type: 'hello',
        protocol: 2,
        noise: noise.write().toString('base64')
      })
      noise.read(decodeFrame(host.receive(hello).frames[0]!))
      const third = noise.write((hash) =>
        Buffer.from(
          JSON.stringify({
            type: 'request',
            name: 'Pixel 9',
            identityKey: identity.publicKey,
            signature: sign(
              null,
              identitySignedData('device', staticKey.publicKey, hash),
              identity.privateKey
            ).toString('base64'),
            commit: approvalCommit(Buffer.alloc(32, 1))
          })
        )
      )
      const nonce = host.receive(third.toString('base64'))
      expect(nonce.kind).toBe('reply')
      const channel = new SecureFrameChannel(noise.transport(), MAX)
      expect(JSON.parse(channel.open(nonce.frames[0]!)!)).toMatchObject({ type: 'nonce' })
      const lie = channel.seal(
        JSON.stringify({ type: 'reveal', nonce: Buffer.alloc(32, 2).toString('base64') })
      )
      expect(host.receive(lie[0]!)).toMatchObject({
        kind: 'denied',
        reason: 'the reveal does not match the commitment'
      })
      expect(store.devices()).toEqual([])
    })

    it('adds nothing when declined, and the window is spent', () => {
      store.startPairing()
      const { outcome } = ask()
      if (outcome.kind !== 'approval') throw new Error('expected approval')
      expect(outcome.decide(false)).toMatchObject({
        kind: 'denied',
        reason: 'the request was declined'
      })
      expect(store.devices()).toEqual([])
      expect(store.pairing()).toBeUndefined()
      // A second answer changes nothing.
      expect(outcome.decide(true).kind).toBe('denied')
      expect(store.devices()).toEqual([])
    })

    it('adds nothing when the window closed before the answer', () => {
      store.startPairing()
      const { outcome } = ask()
      if (outcome.kind !== 'approval') throw new Error('expected approval')
      store.cancelPairing()
      expect(outcome.decide(true)).toMatchObject({
        kind: 'denied',
        reason: 'the Add device window closed before the answer'
      })
      expect(store.devices()).toEqual([])
    })

    it('refuses anything the device sends before the answer', () => {
      store.startPairing()
      const { host, outcome } = ask()
      expect(outcome.kind).toBe('approval')
      expect(host.receive('x')).toMatchObject({
        kind: 'denied',
        reason: 'message before the request was answered'
      })
    })

    it('gives one request per window its value: the next is refused before it learns anything', () => {
      store.startPairing()
      const host = server()
      const first = requester()
      const third = first.receive(host.receive(first.start()).frames[0]!) as { frames: string[] }
      expect(host.receive(third.frames[0]!).kind).toBe('reply')
      // A second request in the same window, side by side with the first.
      const { outcome } = ask()
      expect(outcome).toMatchObject({
        kind: 'denied',
        reason: 'another device is already pairing in this window'
      })
    })

    it('a request from a closed window can neither ask nor spend the window opened since', () => {
      // Before the reveal: the person closed Add device and made a new code meanwhile.
      store.startPairing()
      const host = server()
      const device = requester()
      const third = device.receive(host.receive(device.start()).frames[0]!) as { frames: string[] }
      const nonce = host.receive(third.frames[0]!)
      store.cancelPairing()
      const fresh = store.startPairing()
      const reveal = device.receive(nonce.frames[0]!) as { frames: string[] }
      expect(host.receive(reveal.frames[0]!)).toMatchObject({
        kind: 'denied',
        reason: 'the Add device window it claimed is closed'
      })
      expect(store.pairing()).toBe(fresh)

      // After the question: an answer to it must not spend the new window either.
      const { outcome } = ask()
      if (outcome.kind !== 'approval') throw new Error('expected approval')
      store.cancelPairing()
      const newer = store.startPairing()
      expect(outcome.decide(false).kind).toBe('denied')
      expect(outcome.decide(true).kind).toBe('denied')
      expect(store.pairing()).toBe(newer)
      expect(store.devices()).toEqual([])
    })

    it('a host that takes no requests refuses one before sending its value', () => {
      store.startPairing()
      const offer = store.pairing()
      const { outcome } = ask(createSecureServerHandshake({ store, maxMessageBytes: MAX }))
      expect(outcome).toMatchObject({
        kind: 'denied',
        reason: 'this host takes no pairing requests'
      })
      // Its QR still works.
      expect(store.pairing()).toBe(offer)
      expect(store.pairing()?.claimed).toBeUndefined()
    })

    it('refuses a request with anything beyond its fields', () => {
      store.startPairing()
      const host = server()
      const identity = deviceIdentity()
      const noise = new NoiseXX({
        initiator: true,
        staticKey: generateNoiseKeyPair(),
        prologue: NOISE_PROLOGUE
      })
      const hello = JSON.stringify({
        type: 'hello',
        protocol: 2,
        noise: noise.write().toString('base64')
      })
      noise.read(decodeFrame(host.receive(hello).frames[0]!))
      const third = noise.write(() =>
        Buffer.from(
          JSON.stringify({
            type: 'request',
            name: 'Pixel 9',
            identityKey: identity.publicKey,
            signature: Buffer.alloc(64).toString('base64'),
            commit: '0'.repeat(64),
            pad: 'anything'
          })
        )
      )
      expect(host.receive(third.toString('base64'))).toMatchObject({
        kind: 'denied',
        reason: 'expected auth, pair or request'
      })
    })

    it('refuses a request whose signature is not by the key it names', () => {
      store.startPairing()
      const { outcome } = ask(
        server(),
        requester({
          privateKey: deviceIdentity().privateKey,
          publicKey: deviceIdentity().publicKey
        })
      )
      expect(outcome).toMatchObject({ kind: 'denied', reason: 'bad device signature' })
    })

    it('shows a name cleaned of controls, direction overrides and zero-width marks', () => {
      store.startPairing()
      const { outcome } = ask(
        server(),
        requester(deviceIdentity(), 'Pixel‮9​\n(code\t123456)\u0007')
      )
      if (outcome.kind !== 'approval') throw new Error('expected approval')
      expect(outcome.name).toBe('Pixel 9 (code 123456)')
      const blank = (() => {
        store.startPairing()
        const again = ask(server(), requester(deviceIdentity(), '​‮ '))
        return again.outcome.kind === 'approval' ? again.outcome.name : ''
      })()
      expect(blank).toBe('Unnamed device')
    })

    it('someone in the middle shows different codes on the two screens', () => {
      // They run one handshake with the device (posing as the host) and one with the host (posing
      // as the device). Each hash covers that handshake's keys only, so the codes cannot match.
      store.startPairing()
      const impostorStore = createAccessStore({
        path: join(dir, 'impostor.json'),
        now: () => 1_000_000
      })
      impostorStore.startPairing()
      const toDevice = ask(
        createSecureServerHandshake({
          store: impostorStore,
          maxMessageBytes: MAX,
          acceptsRequests: true
        })
      )
      const toHost = ask()
      if (toDevice.outcome.kind !== 'approval' || toHost.outcome.kind !== 'approval') {
        throw new Error('expected two questions')
      }
      expect(toDevice.step!.approval!.code).not.toBe(toHost.outcome.code)
      // And the device would pin the impostor's key, not the host's.
      expect(toDevice.step!.approval!.hostFingerprint).not.toBe(fingerprint())
    })

    it('still checks a pinned host when the device has one', () => {
      store.startPairing()
      const device = createSecureClientHandshake({
        pinnedFingerprint: '0'.repeat(64),
        identity: deviceIdentity(),
        signIn: { type: 'request', name: 'Pixel 9' },
        maxMessageBytes: MAX
      })
      const host = server()
      const reply = host.receive(device.start())
      expect(() => device.receive(reply.frames[0]!)).toThrow(/not the one this device paired with/)
    })

    it('needs a fingerprint to sign in or pair with a QR', () => {
      expect(() =>
        createSecureClientHandshake({
          identity: deviceIdentity(),
          signIn: { type: 'auth', deviceId: 'x' },
          maxMessageBytes: MAX
        })
      ).toThrow(SecureHandshakeError)
    })

    it('derives six digits from the handshake hash and both random values', () => {
      const h = Buffer.alloc(32)
      const nd = Buffer.alloc(32, 1)
      const nh = Buffer.alloc(32, 2)
      expect(approvalCode(h, nd, nh)).toMatch(/^\d{6}$/)
      expect(approvalCode(h, nd, nh)).toBe(approvalCode(h, nd, nh))
      expect(approvalCode(h, nd, nh)).not.toBe(approvalCode(Buffer.alloc(32, 1), nd, nh))
      expect(approvalCode(h, nd, nh)).not.toBe(approvalCode(h, Buffer.alloc(32, 3), nh))
      expect(approvalCode(h, nd, nh)).not.toBe(approvalCode(h, nd, Buffer.alloc(32, 3)))
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

  it('refuses protocol 1 without a plaintext byte, so nothing can downgrade a session', () => {
    const plainHello = JSON.stringify({ type: 'hello', protocol: 1, clientNonce: 'a'.repeat(32) })
    expect(server().receive(plainHello)).toMatchObject({ kind: 'denied', frames: [] })
    expect(server().receive('{"type":"hello"}')).toMatchObject({ kind: 'denied', frames: [] })
  })
})
