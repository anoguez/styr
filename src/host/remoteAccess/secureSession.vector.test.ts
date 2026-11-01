import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fingerprintOf } from './handshake.js'
import { NoiseXX, keyPairFromPrivate } from './noise.js'
import { createSecureClientHandshake } from './secureClient.js'
import {
  NOISE_PROLOGUE,
  SecureFrameChannel,
  createSecureServerHandshake,
  identitySignedData,
  type SecureHandshakeStore
} from './secureSession.js'

/**
 * Full protocol-2 transcripts from fixed keys, for the Dart client to replay byte for byte
 * (styr-app's tests read the same file). Ed25519 signatures and Noise with fixed ephemerals are
 * deterministic, so the Node side must reproduce the file exactly too.
 *
 * `UPDATE_SECURE_VECTOR=1 yarn vitest run src/host/remoteAccess/secureSession.vector.test.ts`
 * rewrites it; any change there is a wire change and needs the Dart side updated with it.
 */

const VECTOR_PATH = join(import.meta.dirname, 'secureSession.vector.json')
const MAX = 8 * 1024 * 1024
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

const seed = (label: string): Buffer => createHash('sha256').update(`styr-vector ${label}`).digest()

function ed25519(label: string) {
  const raw = seed(label)
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8'
  })
  const publicKey = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'der' })
    .toString('base64')
  return { seed: raw.toString('hex'), privateKey, publicKey }
}

const x25519 = (label: string) => keyPairFromPrivate(seed(label))

const host = ed25519('host identity')
const phone = ed25519('phone identity')
const SECRET = seed('qr secret').subarray(0, 20).toString('hex')
const DEVICE_ID = 'device-1'
const NAME = 'iPhone'

const hostStore: SecureHandshakeStore = {
  identity: () => ({
    fingerprint: fingerprintOf(host.publicKey),
    publicKey: host.publicKey,
    sign: (data) => sign(null, Buffer.from(data), host.privateKey).toString('base64'),
    signBytes: (data) => sign(null, data, host.privateKey)
  }),
  reload: () => undefined,
  publicKeyFor: (id) => (id === DEVICE_ID ? phone.publicKey : undefined),
  consumePairing: () => ({ secret: SECRET, expiresAt: Number.MAX_SAFE_INTEGER }),
  addDevice: (name) => ({ id: DEVICE_ID, name, createdAt: '' })
}

interface Frame {
  from: 'phone' | 'host'
  frame: string
}

/** One message of the session after `ready`: either literal text or `repeat` × `count`. */
type Message = { from: 'phone' | 'host'; text?: string; repeat?: string; count?: number }

const TRANSPORT: Message[] = [
  { from: 'phone', text: '{"jsonrpc":"2.0","id":1,"method":"server:hello","params":[]}' },
  { from: 'host', text: '{"jsonrpc":"2.0","id":1,"result":{"protocol":1}}' },
  { from: 'host', text: '{"jsonrpc":"2.0","method":"terminal:data","params":["é ✓ 🙂"]}' },
  { from: 'phone', text: '' }
]
/** Just over one record: two Noise messages, the first a full chunk. Only in the sign-in. */
const LARGE: Message[] = [
  { from: 'phone', repeat: 'styr ', count: 13_200 },
  { from: 'host', repeat: 'ok', count: 33_000 }
]

const textOf = (message: Message): string => message.text ?? message.repeat!.repeat(message.count!)

function session(name: 'pair' | 'signIn') {
  const keys = {
    hostStatic: x25519(`${name} host static`),
    hostEphemeral: x25519(`${name} host ephemeral`),
    phoneStatic: x25519(`${name} phone static`),
    phoneEphemeral: x25519(`${name} phone ephemeral`)
  }
  const server = createSecureServerHandshake({
    store: hostStore,
    maxMessageBytes: MAX,
    staticKey: keys.hostStatic,
    ephemeralKey: keys.hostEphemeral
  })
  const client = createSecureClientHandshake({
    pinnedFingerprint: fingerprintOf(host.publicKey),
    identity: { privateKey: phone.privateKey, publicKey: phone.publicKey },
    signIn:
      name === 'pair'
        ? { type: 'pair', name: NAME, secret: SECRET }
        : { type: 'auth', deviceId: DEVICE_ID },
    maxMessageBytes: MAX,
    staticKey: keys.phoneStatic,
    ephemeralKey: keys.phoneEphemeral
  })
  const frames: Frame[] = []
  const toHost = [client.start()]
  let hostChannel: SecureFrameChannel | undefined
  let phoneChannel: SecureFrameChannel | undefined
  while (toHost.length > 0 && !phoneChannel) {
    const frame = toHost.shift()!
    frames.push({ from: 'phone', frame })
    const outcome = server.receive(frame)
    if (outcome.kind === 'denied') throw new Error(outcome.reason)
    if (outcome.kind === 'ready') hostChannel = outcome.channel
    for (const reply of outcome.frames) {
      frames.push({ from: 'host', frame: reply })
      const step = client.receive(reply)
      if (step.kind === 'send') toHost.push(...step.frames)
      if (step.kind === 'ready') phoneChannel = step.channel
    }
  }
  const transport = [...TRANSPORT, ...(name === 'signIn' ? LARGE : [])].map((message) => {
    const [from, to] =
      message.from === 'phone' ? [phoneChannel!, hostChannel!] : [hostChannel!, phoneChannel!]
    const sealed = from.seal(textOf(message))
    const opened = sealed.map((frame) => to.open(frame))
    if (opened.at(-1) !== textOf(message)) throw new Error('transcript does not round-trip')
    return { ...message, frames: sealed }
  })
  return {
    name,
    keys: Object.fromEntries(
      Object.entries(keys).map(([key, pair]) => [key, pair.privateKey.toString('hex')])
    ),
    frames,
    handshakeHash: hostChannel!.handshakeHash.toString('hex'),
    transport
  }
}

/**
 * A host message 2 the phone must refuse: `wrongHost` is a host with another identity, and
 * `unboundSignature` the real identity signing a Noise key other than the one in the handshake (a
 * relay replaying a signature from elsewhere).
 */
function refusedHosts() {
  const phoneEphemeral = x25519('refused phone ephemeral')
  const phoneStatic = x25519('refused phone static')
  const hello = new NoiseXX({
    initiator: true,
    staticKey: phoneStatic,
    prologue: NOISE_PROLOGUE,
    ephemeralKey: phoneEphemeral
  }).write()
  const answer = (label: string, identity: ReturnType<typeof ed25519>, signedStatic?: Buffer) => {
    const staticKey = x25519(`${label} static`)
    const responder = new NoiseXX({
      initiator: false,
      staticKey,
      prologue: NOISE_PROLOGUE,
      ephemeralKey: x25519(`${label} ephemeral`)
    })
    responder.read(hello)
    const reply = responder.write((hash) =>
      Buffer.from(
        JSON.stringify({
          identityKey: identity.publicKey,
          signature: sign(
            null,
            identitySignedData('host', signedStatic ?? staticKey.publicKey, hash),
            identity.privateKey
          ).toString('base64')
        })
      )
    )
    return reply.toString('base64')
  }
  return {
    phoneStatic: phoneStatic.privateKey.toString('hex'),
    phoneEphemeral: phoneEphemeral.privateKey.toString('hex'),
    hello: JSON.stringify({ type: 'hello', protocol: 2, noise: hello.toString('base64') }),
    wrongHost: answer('wrong host', ed25519('another host identity')),
    unboundSignature: answer('unbound', host, x25519('elsewhere static').publicKey)
  }
}

/** Frame sequences of the sign-in session's first phone message the host must refuse. */
function refusedTransport(signIn: ReturnType<typeof session>) {
  const [one, two] = signIn.transport.filter((message) => message.from === 'phone')
  const first = one!.frames[0]!
  const second = two!.frames[0]!
  const flipped = Buffer.from(first, 'base64')
  flipped[flipped.length - 1]! ^= 1
  return [
    { name: 'tampered', frames: [flipped.toString('base64')], failsAt: 0 },
    { name: 'replayed', frames: [first, first], failsAt: 1 },
    { name: 'reordered', frames: [second, first], failsAt: 0 },
    { name: 'dropped', frames: [second], failsAt: 0 }
  ]
}

function build() {
  const pair = session('pair')
  const signIn = session('signIn')
  return {
    description:
      'Styr protocol 2 (Noise_XX_25519_ChaChaPoly_SHA256 + identity binding) transcripts. ' +
      'Generated by src/host/remoteAccess/secureSession.vector.test.ts; see ' +
      'docs/architecture/remote-access.md, "Protocol 2".',
    prologue: NOISE_PROLOGUE.toString('hex'),
    maxMessageBytes: MAX,
    host: {
      identitySeed: host.seed,
      identityKey: host.publicKey,
      fingerprint: fingerprintOf(host.publicKey)
    },
    phone: { identitySeed: phone.seed, identityKey: phone.publicKey, name: NAME },
    secret: SECRET,
    deviceId: DEVICE_ID,
    sessions: [pair, signIn],
    refusedHosts: refusedHosts(),
    refusedTransport: refusedTransport(signIn)
  }
}

describe('protocol-2 transcript vector', () => {
  const vector = build()

  it('matches secureSession.vector.json', () => {
    const text = `${JSON.stringify(vector, null, 2)}\n`
    if (process.env.UPDATE_SECURE_VECTOR === '1') writeFileSync(VECTOR_PATH, text)
    expect(JSON.parse(readFileSync(VECTOR_PATH, 'utf8'))).toEqual(JSON.parse(text))
  })

  it('the host refuses every sequence in refusedTransport where it says', () => {
    const signIn = vector.sessions[1]!
    for (const refused of vector.refusedTransport) {
      // A fresh host side of the same sign-in session, replayed from its transcript.
      const server = createSecureServerHandshake({
        store: hostStore,
        maxMessageBytes: MAX,
        staticKey: keyPairFromPrivate(Buffer.from(signIn.keys.hostStatic!, 'hex')),
        ephemeralKey: keyPairFromPrivate(Buffer.from(signIn.keys.hostEphemeral!, 'hex'))
      })
      let channel: SecureFrameChannel | undefined
      for (const { from, frame } of signIn.frames) {
        if (from !== 'phone') continue
        const outcome = server.receive(frame)
        if (outcome.kind === 'ready') channel = outcome.channel
      }
      refused.frames.forEach((frame, index) => {
        if (index < refused.failsAt) channel!.open(frame)
        else if (index === refused.failsAt) expect(() => channel!.open(frame)).toThrow()
      })
    }
  })

  it('the phone refuses both refusedHosts answers', () => {
    const { refusedHosts: refused } = vector
    for (const answer of [refused.wrongHost, refused.unboundSignature]) {
      const client = createSecureClientHandshake({
        pinnedFingerprint: vector.host.fingerprint,
        identity: { privateKey: phone.privateKey, publicKey: phone.publicKey },
        signIn: { type: 'auth', deviceId: DEVICE_ID },
        maxMessageBytes: MAX,
        staticKey: keyPairFromPrivate(Buffer.from(refused.phoneStatic, 'hex')),
        ephemeralKey: keyPairFromPrivate(Buffer.from(refused.phoneEphemeral, 'hex'))
      })
      expect(client.start()).toBe(refused.hello)
      expect(() => client.receive(answer)).toThrow(/not the one this device paired with/)
    }
  })
})
