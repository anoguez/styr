import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { AccessStore } from './accessStore.js'
import {
  DUMMY_KEY,
  HANDSHAKE_MAX_BYTES,
  signatureValid,
  validDevicePublicKey,
  type HandshakeResult
} from './handshake.js'
import {
  NOISE_MAX_MESSAGE,
  NoiseXX,
  generateNoiseKeyPair,
  type NoiseKeyPair,
  type NoiseTransport
} from './noise.js'

/**
 * Protocol 2: the handshake and session of `handshake.ts`, end to end encrypted with Noise XX
 * (`noise.ts`), for a path the host does not trust (a relay). `docs/architecture/remote-access.md`
 * ("Protocol 2") is the wire description; the Dart client in styr-app implements the same and is
 * checked against `secureSession.vector.json`.
 *
 *   C → S  {"type":"hello","protocol":2,"noise":b64(-> e)}
 *   S → C  b64(<- e, ee, s, es, payload {identityKey, signature})
 *   C → S  b64(-> s, se, payload {type:'auth', deviceId, signature}
 *                             or {type:'pair', name, identityKey, signature, proof})
 *   S → C  sealed {type:'paired', deviceId}? then sealed {type:'ready'}, then JSON-RPC, sealed
 *
 * Each side's Noise static key is made per connection: identity is the Ed25519 key, bound to the
 * session by signing `"styr-noise-v1\n" + static + handshake hash`. The client checks the host's
 * identity against the pinned fingerprint before it sends anything about itself.
 */

export const SECURE_PROTOCOL = 2
/** Both sides start the handshake from these bytes. */
export const NOISE_PROLOGUE = Buffer.from('styr-noise-v1')
const IDENTITY_CONTEXT = Buffer.from('styr-noise-v1\n')
const PAIR_CONTEXT = Buffer.from('styr-noise-pair-v1\n')

/** One record: a flag byte (1 = the message ends here, 0 = more follows) and a piece of it. */
const RECORD_FINAL = 1
const RECORD_MORE = 0
/** A non-final record carries exactly this much, so a peer cannot split a message into crumbs. */
export const RECORD_CHUNK_BYTES = NOISE_MAX_MESSAGE - 16 - 1
/** The longest text frame protocol 2 sends: one Noise message, base64. */
export const SECURE_FRAME_MAX_CHARS = Math.ceil(NOISE_MAX_MESSAGE / 3) * 4

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Strict base64: the lenient decoder would accept other spellings of the same bytes. */
export function decodeFrame(frame: string): Buffer {
  if (frame.length > SECURE_FRAME_MAX_CHARS || !BASE64.test(frame)) {
    throw new Error('not a protocol-2 frame')
  }
  return Buffer.from(frame, 'base64')
}

/** What an identity signature covers: its Noise static key and the handshake so far. */
export function identitySignedData(staticKey: Buffer, handshakeHash: Buffer): Buffer {
  return Buffer.concat([IDENTITY_CONTEXT, staticKey, handshakeHash])
}

/**
 * The pairing proof: keyed by the QR's secret, which never travels, and covering the handshake
 * hash (both ephemeral and both static keys), so a relay in the middle cannot make one.
 */
export function securePairProof(
  secret: string,
  handshakeHash: Buffer,
  name: string,
  identityKey: string
): string {
  return createHmac('sha256', secret)
    .update(Buffer.concat([PAIR_CONTEXT, handshakeHash, Buffer.from(`\n${name}\n${identityKey}`)]))
    .digest('hex')
}

const base64Text = (max: number) => z.string().max(max)
const signature = z.string().min(80).max(100)
const identityKey = z.string().min(40).max(100)

export const secureHelloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.literal(SECURE_PROTOCOL),
  noise: base64Text(HANDSHAKE_MAX_BYTES)
})
export const hostPayloadSchema = z.object({ identityKey, signature })
export const clientPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), deviceId: z.string().min(1).max(100), signature }),
  z.object({
    type: z.literal('pair'),
    name: z.string().max(200),
    identityKey,
    signature,
    proof: z.string().regex(/^[0-9a-f]{64}$/)
  })
])

export class SecureChannelError extends Error {}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * A session's messages over Noise transport, as text frames. Any frame that fails (tampered,
 * replayed, reordered, after a dropped one, malformed) breaks the channel for good: the caller
 * ends the connection.
 */
export class SecureFrameChannel {
  private pending: Buffer[] = []
  private pendingBytes = 0
  private broken = false

  constructor(
    private readonly transport: NoiseTransport,
    /** The longest message `open` reassembles. */
    private readonly maxMessageBytes: number
  ) {}

  /** The same on both sides; what a test can compare. */
  get handshakeHash(): Buffer {
    return Buffer.from(this.transport.hash)
  }

  seal(message: string): string[] {
    this.usable()
    const bytes = Buffer.from(message, 'utf8')
    const frames: string[] = []
    let offset = 0
    do {
      const piece = bytes.subarray(offset, offset + RECORD_CHUNK_BYTES)
      offset += piece.length
      const flag = offset >= bytes.length ? RECORD_FINAL : RECORD_MORE
      const record = Buffer.concat([Buffer.from([flag]), piece])
      frames.push(this.transport.send.encrypt(record).toString('base64'))
    } while (offset < bytes.length)
    return frames
  }

  /** The message `frame` completes, or undefined while one is still arriving. Throws on any fault. */
  open(frame: string): string | undefined {
    this.usable()
    try {
      const record = this.transport.receive.decrypt(decodeFrame(frame))
      const flag = record[0]
      const piece = record.subarray(1)
      if (flag === RECORD_MORE && piece.length !== RECORD_CHUNK_BYTES) {
        throw new Error('short record')
      }
      if (flag !== RECORD_MORE && flag !== RECORD_FINAL) throw new Error('bad record flag')
      if (this.pendingBytes + piece.length > this.maxMessageBytes) {
        throw new Error('message too large')
      }
      this.pending.push(piece)
      this.pendingBytes += piece.length
      if (flag === RECORD_MORE) return undefined
      const message = utf8.decode(Buffer.concat(this.pending))
      this.pending = []
      this.pendingBytes = 0
      return message
    } catch (error) {
      this.broken = true
      this.pending = []
      throw new SecureChannelError(
        `protocol 2: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private usable(): void {
    if (this.broken) throw new SecureChannelError('protocol 2: the channel is closed')
  }
}

/** What the server side needs of the store. */
export type SecureHandshakeStore = Pick<
  AccessStore,
  'identity' | 'reload' | 'publicKeyFor' | 'consumePairing' | 'addDevice'
>

export type SecureHandshakeResult =
  | { kind: 'reply'; frames: string[] }
  | {
      kind: 'ready'
      frames: string[]
      deviceId: string
      paired: boolean
      channel: SecureFrameChannel
    }
  | { kind: 'denied'; frames: string[]; reason: string }

function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

function jsonPayload(payload: Buffer): unknown {
  return JSON.parse(utf8.decode(payload))
}

/** The host's side of a protocol-2 connection, driven by the text frames it receives. */
export function createSecureServerHandshake(options: {
  store: SecureHandshakeStore
  /** The longest JSON-RPC message the session accepts. */
  maxMessageBytes: number
  /** Tests only: fixed keys, for the transcript vector. */
  staticKey?: NoiseKeyPair
  ephemeralKey?: NoiseKeyPair
}) {
  const staticKey = options.staticKey ?? generateNoiseKeyPair()
  const noise = new NoiseXX({
    initiator: false,
    staticKey,
    prologue: NOISE_PROLOGUE,
    ephemeralKey: options.ephemeralKey
  })
  let state: 'hello' | 'final' | 'done' = 'hello'

  const deny = (reason: string): SecureHandshakeResult => {
    state = 'done'
    // As in protocol 1, every refusal looks the same: the connection closes with 4401.
    return { kind: 'denied', reason, frames: [] }
  }

  function hello(text: string): SecureHandshakeResult {
    const message = secureHelloSchema.safeParse(JSON.parse(text))
    if (!message.success) return deny('expected a protocol-2 hello')
    if (noise.read(decodeFrame(message.data.noise)).payload.length !== 0) {
      return deny('unexpected payload in the first message')
    }
    const identity = options.store.identity()
    const reply = noise.write((hash) =>
      Buffer.from(
        JSON.stringify({
          identityKey: identity.publicKey,
          signature: identity
            .signBytes(identitySignedData(staticKey.publicKey, hash))
            .toString('base64')
        })
      )
    )
    state = 'final'
    return { kind: 'reply', frames: [reply.toString('base64')] }
  }

  function final(text: string): SecureHandshakeResult {
    const { payload, hashBeforePayload } = noise.read(decodeFrame(text))
    const parsed = clientPayloadSchema.safeParse(jsonPayload(payload))
    if (!parsed.success) return deny('expected auth or pair')
    const signed = identitySignedData(noise.remoteStatic!, hashBeforePayload)
    let deviceId: string
    let paired = false
    if (parsed.data.type === 'auth') {
      // A device removed from another process (the CLI) is gone for the next sign-in.
      options.store.reload()
      const publicKey = options.store.publicKeyFor(parsed.data.deviceId)
      const good = signatureValid(publicKey ?? DUMMY_KEY, signed, parsed.data.signature)
      if (!publicKey || !good) return deny('bad device signature')
      deviceId = parsed.data.deviceId
    } else {
      // The offer is spent by the attempt, so a wrong guess cannot be retried against it.
      const offer = options.store.consumePairing()
      if (!offer) return deny('no open pairing')
      const expected = securePairProof(
        offer.secret,
        hashBeforePayload,
        parsed.data.name,
        parsed.data.identityKey
      )
      if (!equalHex(expected, parsed.data.proof)) return deny('bad pairing proof')
      if (!validDevicePublicKey(parsed.data.identityKey)) return deny('not an Ed25519 key')
      if (!signatureValid(parsed.data.identityKey, signed, parsed.data.signature)) {
        return deny('bad device signature')
      }
      try {
        deviceId = options.store.addDevice(parsed.data.name, parsed.data.identityKey).id
      } catch (error) {
        return deny(error instanceof Error ? error.message : 'could not add the device')
      }
      paired = true
    }
    state = 'done'
    const channel = new SecureFrameChannel(noise.transport(), options.maxMessageBytes)
    const frames = [
      ...(paired ? channel.seal(JSON.stringify({ type: 'paired', deviceId })) : []),
      ...channel.seal(JSON.stringify({ type: 'ready' }))
    ]
    return { kind: 'ready', frames, deviceId, paired, channel }
  }

  return {
    receive(text: string): SecureHandshakeResult {
      if (state === 'done') return deny('message after the handshake ended')
      if (Buffer.byteLength(text) > HANDSHAKE_MAX_BYTES) return deny('handshake message too large')
      try {
        return state === 'hello' ? hello(text) : final(text)
      } catch (error) {
        // A frame Noise refuses, bad JSON, a key the keychain will not give up.
        return deny(error instanceof Error ? error.message : String(error))
      }
    }
  }
}

export type ConnectionHandshakeResult =
  | { kind: 'reply'; frames: string[] }
  | {
      kind: 'ready'
      frames: string[]
      deviceId: string
      paired: boolean
      /** Set for protocol 2: every later frame goes through it. */
      channel?: SecureFrameChannel
    }
  | { kind: 'denied'; frames: string[]; reason: string }

/**
 * Which protocol-2 sessions a listener takes: `off` (direct mode today), `allow` (either, picked by
 * the client's hello) or `require` (a relay: protocol 1 is refused, so there is no downgrade).
 */
export type SecureSessions = 'off' | 'allow' | 'require'

/**
 * One connection's handshake, protocol 1 or 2 according to its first frame and `secure`. A
 * protocol-1 server answers a protocol-2 hello with its usual protocol error, so an older host
 * says so instead of hanging.
 */
export function createConnectionHandshake(options: {
  secure: SecureSessions
  /** The protocol the plain handshake speaks, named in its refusal of a protocol-2 hello. */
  protocol: number
  plain: () => { receive(text: string): HandshakeResult }
  secureHandshake: () => ReturnType<typeof createSecureServerHandshake>
}) {
  let chosen: ((text: string) => ConnectionHandshakeResult) | undefined

  function choose(text: string): (text: string) => ConnectionHandshakeResult {
    let wantsSecure = false
    try {
      const first = JSON.parse(text) as { protocol?: unknown }
      wantsSecure = first?.protocol === SECURE_PROTOCOL
    } catch {
      // Not JSON: either handshake refuses it.
    }
    if (options.secure !== 'off' && (wantsSecure || options.secure === 'require')) {
      const secure = options.secureHandshake()
      return (frame) => secure.receive(frame)
    }
    if (wantsSecure) {
      return () => ({
        kind: 'denied',
        reason: 'protocol 2 is off',
        frames: [JSON.stringify({ type: 'error', code: 'protocol', protocol: options.protocol })]
      })
    }
    const plain = options.plain()
    return (frame) => {
      const outcome = plain.receive(frame)
      return { ...outcome, frames: outcome.messages.map((message) => JSON.stringify(message)) }
    }
  }

  return {
    receive(text: string): ConnectionHandshakeResult {
      chosen ??= choose(text)
      return chosen(text)
    }
  }
}
