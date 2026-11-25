import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { notificationText } from '@core/remote.js'
import { z } from 'zod'
import type { AccessStore, PairingOffer } from './accessStore.js'
import {
  DUMMY_KEY,
  HANDSHAKE_MAX_BYTES,
  signatureValid,
  validDevicePublicKey
} from './handshake.js'
import {
  NOISE_MAX_MESSAGE,
  NoiseXX,
  generateNoiseKeyPair,
  type NoiseKeyPair,
  type NoiseTransport
} from './noise.js'

/**
 * Protocol 2, the only one: the handshake and session of every network connection, end to end
 * encrypted with Noise XX (`noise.ts`). `docs/architecture/remote-access.md`
 * ("Protocol 2") is the wire description; the Dart client in styr-app implements the same and is
 * checked against `secureSession.vector.json`.
 *
 *   C → S  {"type":"hello","protocol":2,"noise":b64(-> e)}
 *   S → C  b64(<- e, ee, s, es, payload {identityKey, signature})
 *   C → S  b64(-> s, se, payload {type:'auth', deviceId, signature}
 *                             or {type:'pair', name, identityKey, signature, proof}
 *                             or {type:'request', name, identityKey, signature, commit})
 *   S → C  sealed {type:'paired', deviceId}? then sealed {type:'ready'}, then JSON-RPC, sealed
 *
 * `request` is pairing by approval, for a device that found the host on the network instead of
 * scanning its QR: accepted only while the host's Add device window is open, it waits until the
 * person at the host allows it, having checked that both screens show the same `approvalCode`.
 * Before the code exists, each side adds a random value in a fixed order, commit then reveal:
 *
 *   C → S  message 3 carries commit = hex SHA-256(Nd), Nd 32 random bytes kept by the device
 *   S → C  sealed {type:'nonce', nonce: b64(Nh)}           Nh 32 random bytes
 *   C → S  sealed {type:'reveal', nonce: b64(Nd)}         must hash to the commit
 *
 * The code is then `approvalCode(h, Nd, Nh)`. Whoever sits in between is bound to one Nd before
 * it sees the host's Nh, and must give the device its Nh before it sees the device's Nd, so it
 * cannot try values until the two codes match: one chance in a million, per attempt that the
 * person at the host must answer.
 *
 * Each side's Noise static key is made per connection: identity is the Ed25519 key, bound to the
 * session by signing `"styr-noise-v1\n" + static + handshake hash`. The client checks the host's
 * identity against the pinned fingerprint before it sends anything about itself.
 */

export const SECURE_PROTOCOL = 2
/** Both sides start the handshake from these bytes. */
export const NOISE_PROLOGUE = Buffer.from('styr-noise-v1')
/** Each role signs under its own label, so one side's signature can never stand for the other's. */
const IDENTITY_CONTEXT = {
  host: Buffer.from('styr-noise-host-v1\n'),
  device: Buffer.from('styr-noise-device-v1\n')
} as const
const PAIR_CONTEXT = Buffer.from('styr-noise-pair-v1\n')
const APPROVAL_CONTEXT = Buffer.from('styr-noise-approval-v2\n')
/** The random value each side adds to a request's code. */
export const APPROVAL_NONCE_BYTES = 32

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

/** What an identity signature covers: the signer's role, its Noise static key and the handshake so far. */
export function identitySignedData(
  role: 'host' | 'device',
  staticKey: Buffer,
  handshakeHash: Buffer
): Buffer {
  return Buffer.concat([IDENTITY_CONTEXT[role], staticKey, handshakeHash])
}

/**
 * The pairing proof: keyed by the QR's secret, which never travels, and covering the handshake
 * hash (both ephemeral and both static keys), so anyone in the middle cannot make one.
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

/**
 * The six digits both screens show while a device asks to pair by approval: HMAC-SHA256 keyed by
 * the final handshake hash, over both sides' random values (`Nd` committed to in message 3 before
 * `Nh` was sent, see the top of this file), first four bytes big-endian mod 10⁶. Without the
 * commitment, someone relaying could vary its own message 3 until the codes matched.
 */
export function approvalCode(
  handshakeHash: Buffer,
  deviceNonce: Buffer,
  hostNonce: Buffer
): string {
  const digest = createHmac('sha256', handshakeHash)
    .update(Buffer.concat([APPROVAL_CONTEXT, deviceNonce, hostNonce]))
    .digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

/** What a device's commitment to its random value is: hex SHA-256. */
export function approvalCommit(deviceNonce: Buffer): string {
  return createHash('sha256').update(deviceNonce).digest('hex')
}

/** Zero-width marks, which `notificationText` keeps: they can hide or fake text in a name. */
const ZERO_WIDTH = /[\u061c\u200b-\u200d\u2060\ufeff]/g

/**
 * A device's own name, made safe to show in the host's prompt, log and device list: controls,
 * bidi overrides and zero-width marks removed, whitespace collapsed. A name that is nothing
 * after that reads "Unnamed device".
 */
export function deviceDisplayName(name: string): string {
  return notificationText(name.replace(ZERO_WIDTH, ''), DEVICE_NAME_MAX) || 'Unnamed device'
}

const base64Text = (max: number) => z.string().max(max)
const strictBase64 = (bytes: number) =>
  z
    .string()
    .regex(BASE64)
    .refine((text) => Buffer.from(text, 'base64').length === bytes)
/** Ed25519: a 64-byte signature, and a public key as 44 bytes of SPKI DER. */
const signature = strictBase64(64)
const identityKey = strictBase64(44)
/** Short enough that message 3 stays inside the handshake limit whatever the characters. */
export const DEVICE_NAME_MAX = 100

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
    name: z.string().max(DEVICE_NAME_MAX),
    identityKey,
    signature,
    proof: z.string().regex(/^[0-9a-f]{64}$/)
  }),
  z
    .object({
      type: z.literal('request'),
      name: z.string().max(DEVICE_NAME_MAX),
      identityKey,
      signature,
      commit: z.string().regex(/^[0-9a-f]{64}$/)
    })
    .strict()
])

/** The device's half of a request's code, sealed after the host's (`approvalCode`). */
const revealSchema = z
  .object({ type: z.literal('reveal'), nonce: strictBase64(APPROVAL_NONCE_BYTES) })
  .strict()
/** The host's half, sealed right after message 3 of a request. */
export const hostNonceSchema = z
  .object({ type: z.literal('nonce'), nonce: strictBase64(APPROVAL_NONCE_BYTES) })
  .strict()

export class SecureChannelError extends Error {}

/** Strict, and drops a leading BOM, as Dart's `utf8.decode` does. */
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
      // A sender ends a split message on its last full chunk, never on an empty record.
      if (flag === RECORD_FINAL && piece.length === 0 && this.pending.length > 0) {
        throw new Error('empty final record')
      }
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
  | 'identity'
  | 'reload'
  | 'publicKeyFor'
  | 'pairing'
  | 'claimPairing'
  | 'consumePairing'
  | 'addDevice'
>

export type SecureHandshakeResult =
  | {
      kind: 'reply'
      frames: string[]
      /**
       * Set on the reply that sends a request its host value (`Nh`): the window this request has
       * claimed. From here the peer could work out the code, so if the connection ends without
       * Allow the caller closes that window (`store.cancelPairing(claimed)`).
       */
      claimed?: PairingOffer
    }
  | {
      kind: 'ready'
      frames: string[]
      deviceId: string
      paired: boolean
      channel: SecureFrameChannel
    }
  | { kind: 'denied'; frames: string[]; reason: string }
  | {
      /**
       * A device asks to pair by approval. Nothing is sent until `decide` is called with the
       * person's answer; the caller holds the connection meanwhile and sends what `decide` returns.
       */
      kind: 'approval'
      frames: []
      name: string
      code: string
      decide(allow: boolean): SecureHandshakeResult
    }

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
  /**
   * Whether anyone can answer a request to pair by approval (the desktop's Add device window).
   * Off (`styr serve`), a request is refused before it gets anything.
   */
  acceptsRequests?: boolean
  /** Tests only: a fixed random value for a request's code. */
  hostNonce?: Buffer
}) {
  const staticKey = options.staticKey ?? generateNoiseKeyPair()
  const noise = new NoiseXX({
    initiator: false,
    staticKey,
    prologue: NOISE_PROLOGUE,
    ephemeralKey: options.ephemeralKey
  })
  let state: 'hello' | 'final' | 'reveal' | 'approval' | 'done' = 'hello'
  /** A request between message 3 and the device's reveal. */
  let request:
    | {
        name: string
        identityKey: string
        commit: Buffer
        hostNonce: Buffer
        channel: SecureFrameChannel
        claimed: PairingOffer
      }
    | undefined

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
            .signBytes(identitySignedData('host', staticKey.publicKey, hash))
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
    if (!parsed.success) return deny('expected auth, pair or request')
    const signed = identitySignedData('device', noise.remoteStatic!, hashBeforePayload)
    let deviceId: string
    let paired = false
    if (parsed.data.type === 'request') {
      const { identityKey } = parsed.data
      if (!options.acceptsRequests) return deny('this host takes no pairing requests')
      // Only while the Add device window is open: otherwise nobody is there to answer, and a
      // stranger on the network must not be able to put a prompt on the screen.
      if (!options.store.pairing()) return deny('not accepting pairing requests now')
      if (!validDevicePublicKey(identityKey)) return deny('not an Ed25519 key')
      if (!signatureValid(identityKey, signed, parsed.data.signature)) {
        return deny('bad device signature')
      }
      // One request per window, taken before it learns anything: requests made side by side must
      // not each get a code to compare.
      const claimed = options.store.claimPairing()
      if (!claimed) return deny('another device is already pairing in this window')
      const channel = new SecureFrameChannel(noise.transport(), options.maxMessageBytes)
      const hostNonce = options.hostNonce ?? randomBytes(APPROVAL_NONCE_BYTES)
      request = {
        name: deviceDisplayName(parsed.data.name),
        identityKey,
        commit: Buffer.from(parsed.data.commit, 'hex'),
        hostNonce,
        channel,
        claimed
      }
      state = 'reveal'
      return {
        kind: 'reply',
        frames: channel.seal(
          JSON.stringify({ type: 'nonce', nonce: hostNonce.toString('base64') })
        ),
        claimed
      }
    }
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

  /** The device's random value, checked against its commitment; then the question for the person. */
  function reveal(text: string): SecureHandshakeResult {
    const pending = request!
    // A request belongs to the window it claimed: once that one is gone (closed, or a new code
    // made since), it may not put a question on the screen for another.
    if (options.store.pairing() !== pending.claimed) {
      return deny('the Add device window it claimed is closed')
    }
    const opened = pending.channel.open(text)
    // The reveal is one small record; a split one is not a reveal.
    if (opened === undefined) return deny('expected the reveal in one record')
    const parsed = revealSchema.safeParse(jsonPayload(Buffer.from(opened, 'utf8')))
    if (!parsed.success) return deny('expected the reveal')
    const deviceNonce = Buffer.from(parsed.data.nonce, 'base64')
    const committed = createHash('sha256').update(deviceNonce).digest()
    if (!timingSafeEqual(committed, pending.commit)) {
      return deny('the reveal does not match the commitment')
    }
    const { name, identityKey, channel } = pending
    state = 'approval'
    return {
      kind: 'approval',
      frames: [],
      name,
      code: approvalCode(channel.handshakeHash, deviceNonce, pending.hostNonce),
      decide(allow: boolean): SecureHandshakeResult {
        if (state !== 'approval') return deny('the request was already answered')
        // The window is spent by the answer either way, as a QR's secret is by an attempt. It must
        // still be the window this request claimed: an answer must never spend a newer one.
        if (options.store.pairing() !== pending.claimed) {
          return deny('the Add device window closed before the answer')
        }
        const offer = options.store.consumePairing()
        if (!allow) return deny('the request was declined')
        if (!offer || offer !== pending.claimed) {
          return deny('the Add device window closed before the answer')
        }
        let id: string
        try {
          id = options.store.addDevice(name, identityKey).id
        } catch (error) {
          return deny(error instanceof Error ? error.message : 'could not add the device')
        }
        state = 'done'
        const frames = [
          ...channel.seal(JSON.stringify({ type: 'paired', deviceId: id })),
          ...channel.seal(JSON.stringify({ type: 'ready' }))
        ]
        return { kind: 'ready', frames, deviceId: id, paired: true, channel }
      }
    }
  }

  return {
    receive(text: string): SecureHandshakeResult {
      if (state === 'done') return deny('message after the handshake ended')
      if (state === 'approval') return deny('message before the request was answered')
      if (Buffer.byteLength(text) > HANDSHAKE_MAX_BYTES) return deny('handshake message too large')
      try {
        return state === 'hello' ? hello(text) : state === 'reveal' ? reveal(text) : final(text)
      } catch (error) {
        // A frame Noise refuses, bad JSON, a key the keychain will not give up.
        return deny(error instanceof Error ? error.message : String(error))
      }
    }
  }
}
