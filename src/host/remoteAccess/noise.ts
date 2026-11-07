import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject
} from 'node:crypto'

/**
 * `Noise_XX_25519_ChaChaPoly_SHA256` (https://noiseprotocol.org/noise.html, rev 34), the end-to-end
 * layer of a relayed session (`docs/architecture/remote-access.md`). Plain `node:crypto`, no native
 * module, so the MCP/server path can import it. Checked against the official test vectors
 * (`noiseXX.vector.json`).
 *
 *   -> e
 *   <- e, ee, s, es
 *   -> s, se
 *
 * It authenticates nothing by itself: the caller puts a signature binding its identity to the
 * handshake hash in the payload and checks the peer's (`remoteStatic`, `hashBeforePayload`).
 */

const PROTOCOL_NAME = 'Noise_XX_25519_ChaChaPoly_SHA256'
const KEY_BYTES = 32
const TAG_BYTES = 16
const HASH_BYTES = 32
/** The most a Noise message may hold. */
export const NOISE_MAX_MESSAGE = 65_535

const X25519_PUBLIC_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const X25519_PRIVATE_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

export interface NoiseKeyPair {
  /** 32 raw bytes. */
  privateKey: Buffer
  publicKey: Buffer
}

export function generateNoiseKeyPair(): NoiseKeyPair {
  const { privateKey } = generateKeyPairSync('x25519')
  return keyPairFromPrivate(
    Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).subarray(
      X25519_PRIVATE_PREFIX.length
    )
  )
}

export function keyPairFromPrivate(raw: Buffer): NoiseKeyPair {
  if (raw.length !== KEY_BYTES) throw new Error('A Noise private key is 32 bytes.')
  const publicKey = Buffer.from(
    createPublicKey(privateObject(raw)).export({ format: 'der', type: 'spki' })
  ).subarray(X25519_PUBLIC_PREFIX.length)
  return { privateKey: Buffer.from(raw), publicKey: Buffer.from(publicKey) }
}

function privateObject(raw: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([X25519_PRIVATE_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8'
  })
}

function publicObject(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_PUBLIC_PREFIX, raw]),
    format: 'der',
    type: 'spki'
  })
}

function dh(privateKey: Buffer, publicKey: Buffer): Buffer {
  let shared: Buffer
  try {
    shared = diffieHellman({
      privateKey: privateObject(privateKey),
      publicKey: publicObject(publicKey)
    })
  } catch {
    throw new Error('Noise: invalid public key.')
  }
  // An all-zero secret means a small-order public key; refuse it.
  if (shared.every((byte) => byte === 0)) throw new Error('Noise: invalid public key.')
  return shared
}

const sha256 = (...parts: Buffer[]): Buffer => {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

const hmac = (key: Buffer, ...parts: Buffer[]): Buffer => {
  const mac = createHmac('sha256', key)
  for (const part of parts) mac.update(part)
  return mac.digest()
}

/** Noise HKDF with two outputs. */
function hkdf2(chainingKey: Buffer, input: Buffer): [Buffer, Buffer] {
  const temp = hmac(chainingKey, input)
  const first = hmac(temp, Buffer.from([1]))
  const second = hmac(temp, first, Buffer.from([2]))
  return [first, second]
}

function nonceBytes(counter: number): Buffer {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64LE(BigInt(counter), 4)
  return nonce
}

function seal(key: Buffer, counter: number, ad: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('chacha20-poly1305', key, nonceBytes(counter), {
    authTagLength: TAG_BYTES
  })
  cipher.setAAD(ad, { plaintextLength: plaintext.length })
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([body, cipher.getAuthTag()])
}

function open(key: Buffer, counter: number, ad: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < TAG_BYTES) throw new Error('Noise: message too short.')
  const body = sealed.subarray(0, sealed.length - TAG_BYTES)
  const decipher = createDecipheriv('chacha20-poly1305', key, nonceBytes(counter), {
    authTagLength: TAG_BYTES
  })
  decipher.setAAD(ad, { plaintextLength: body.length })
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
  try {
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new Error('Noise: message failed authentication.')
  }
}

/** One direction of the transport: a key and a counter that only goes up. */
export class NoiseCipher {
  private counter = 0
  constructor(private readonly key: Buffer) {}

  encrypt(plaintext: Buffer, ad: Buffer = Buffer.alloc(0)): Buffer {
    if (plaintext.length + TAG_BYTES > NOISE_MAX_MESSAGE)
      throw new Error('Noise: message too large.')
    return seal(this.key, this.next(), ad, plaintext)
  }

  /** Throws on a tampered, replayed, reordered or dropped message; the session is then over. */
  decrypt(sealed: Buffer, ad: Buffer = Buffer.alloc(0)): Buffer {
    if (sealed.length > NOISE_MAX_MESSAGE) throw new Error('Noise: message too large.')
    return open(this.key, this.next(), ad, sealed)
  }

  private next(): number {
    if (this.counter >= Number.MAX_SAFE_INTEGER) throw new Error('Noise: nonce exhausted.')
    return this.counter++
  }
}

export interface NoiseOptions {
  initiator: boolean
  /** This side's static key pair. */
  staticKey: NoiseKeyPair
  /** Both sides must pass the same bytes; binds the handshake to its use. */
  prologue?: Buffer
  /** Tests only: the vector's ephemeral key. */
  ephemeralKey?: NoiseKeyPair
}

export interface NoiseTransport {
  send: NoiseCipher
  receive: NoiseCipher
  /** The final handshake hash, the same on both sides. */
  hash: Buffer
}

/**
 * One XX handshake. `write` and `read` alternate (initiator writes first); after the third message
 * `transport()` gives the two ciphers.
 */
export class NoiseXX {
  private chainingKey: Buffer
  private hash: Buffer
  private key: Buffer | undefined
  private counter = 0
  private step = 0
  private broken = false
  private split = false
  private ephemeral: NoiseKeyPair | undefined
  private remoteEphemeral: Buffer | undefined
  private remoteStaticKey: Buffer | undefined
  private readonly initiator: boolean
  private readonly staticKey: NoiseKeyPair
  private readonly presetEphemeral: NoiseKeyPair | undefined

  constructor(options: NoiseOptions) {
    this.initiator = options.initiator
    this.staticKey = options.staticKey
    this.presetEphemeral = options.ephemeralKey
    const name = Buffer.from(PROTOCOL_NAME)
    this.hash =
      name.length <= HASH_BYTES
        ? Buffer.concat([name, Buffer.alloc(HASH_BYTES - name.length)])
        : sha256(name)
    this.chainingKey = this.hash
    this.mixHash(options.prologue ?? Buffer.alloc(0))
  }

  /** The peer's static key, known once its `s` token was read. */
  get remoteStatic(): Buffer | undefined {
    return this.remoteStaticKey
  }

  get finished(): boolean {
    return this.step === 3
  }

  /**
   * The next message. `payload` may be a function of the handshake hash at the point the payload is
   * written, which is what an identity signature should cover.
   */
  write(payload: Buffer | ((hashBeforePayload: Buffer) => Buffer) = Buffer.alloc(0)): Buffer {
    this.expect('write')
    return this.once(() => this.writeMessage(payload))
  }

  private writeMessage(payload: Buffer | ((hashBeforePayload: Buffer) => Buffer)): Buffer {
    const parts: Buffer[] = []
    if (this.step === 0 || this.step === 1) {
      this.ephemeral = this.presetEphemeral ?? generateNoiseKeyPair()
      parts.push(this.ephemeral.publicKey)
      this.mixHash(this.ephemeral.publicKey)
    }
    if (this.step === 1) {
      this.mixKey(dh(this.ephemeral!.privateKey, this.remoteEphemeral!))
      parts.push(this.encryptAndHash(this.staticKey.publicKey))
      this.mixKey(dh(this.staticKey.privateKey, this.remoteEphemeral!))
    }
    if (this.step === 2) {
      parts.push(this.encryptAndHash(this.staticKey.publicKey))
      this.mixKey(dh(this.staticKey.privateKey, this.remoteEphemeral!))
    }
    const body = typeof payload === 'function' ? payload(this.hash) : payload
    parts.push(this.encryptAndHash(body))
    const message = Buffer.concat(parts)
    if (message.length > NOISE_MAX_MESSAGE) throw new Error('Noise: message too large.')
    this.step++
    return message
  }

  /** Reads the peer's next message; `hashBeforePayload` is what its payload signature covers. */
  read(message: Buffer): { payload: Buffer; hashBeforePayload: Buffer } {
    this.expect('read')
    return this.once(() => this.readMessage(message))
  }

  private readMessage(message: Buffer): { payload: Buffer; hashBeforePayload: Buffer } {
    if (message.length > NOISE_MAX_MESSAGE) throw new Error('Noise: message too large.')
    let offset = 0
    const take = (length: number): Buffer => {
      if (message.length < offset + length) throw new Error('Noise: message too short.')
      const piece = message.subarray(offset, offset + length)
      offset += length
      return piece
    }
    if (this.step === 0 || this.step === 1) {
      this.remoteEphemeral = Buffer.from(take(KEY_BYTES))
      this.mixHash(this.remoteEphemeral)
    }
    if (this.step === 1) {
      this.mixKey(dh(this.ephemeral!.privateKey, this.remoteEphemeral!))
      const remote = this.decryptAndHash(take(KEY_BYTES + (this.key ? TAG_BYTES : 0)))
      this.remoteStaticKey = remote
      this.mixKey(dh(this.ephemeral!.privateKey, remote))
    }
    if (this.step === 2) {
      const remote = this.decryptAndHash(take(KEY_BYTES + TAG_BYTES))
      this.remoteStaticKey = remote
      this.mixKey(dh(this.ephemeral!.privateKey, remote))
    }
    const hashBeforePayload = Buffer.from(this.hash)
    const payload = this.decryptAndHash(message.subarray(offset))
    this.step++
    return { payload, hashBeforePayload }
  }

  /** The two ciphers; once only, since a second pair would reuse the first one's nonces. */
  transport(): NoiseTransport {
    if (!this.finished) throw new Error('Noise: the handshake is not finished.')
    if (this.split) throw new Error('Noise: the transport was already taken.')
    this.split = true
    const [first, second] = hkdf2(this.chainingKey, Buffer.alloc(0))
    // Nothing of the handshake's keys is needed any more.
    this.chainingKey.fill(0)
    this.key?.fill(0)
    this.key = undefined
    return {
      send: new NoiseCipher(this.initiator ? first : second),
      receive: new NoiseCipher(this.initiator ? second : first),
      hash: Buffer.from(this.hash)
    }
  }

  /** Whose turn it is: the initiator writes on even steps, the responder on odd ones. */
  private expect(action: 'read' | 'write'): void {
    if (this.broken) throw new Error('Noise: the handshake failed.')
    if (this.step >= 3) throw new Error('Noise: the handshake is finished.')
    const myTurn = this.initiator === (this.step % 2 === 0)
    if ((action === 'write') !== myTurn)
      throw new Error(`Noise: not this side's turn to ${action}.`)
  }

  /** A message that fails leaves the state half-mixed: the handshake cannot go on after it. */
  private once<T>(run: () => T): T {
    try {
      return run()
    } catch (error) {
      this.broken = true
      throw error
    }
  }

  private mixHash(data: Buffer): void {
    this.hash = sha256(this.hash, data)
  }

  private mixKey(input: Buffer): void {
    const [chainingKey, key] = hkdf2(this.chainingKey, input)
    this.chainingKey = chainingKey
    this.key = key
    this.counter = 0
  }

  private encryptAndHash(plaintext: Buffer): Buffer {
    if (!this.key) {
      this.mixHash(plaintext)
      return plaintext
    }
    const sealed = seal(this.key, this.counter++, this.hash, plaintext)
    this.mixHash(sealed)
    return sealed
  }

  private decryptAndHash(data: Buffer): Buffer {
    if (!this.key) {
      this.mixHash(data)
      return Buffer.from(data)
    }
    const plaintext = open(this.key, this.counter++, this.hash, data)
    this.mixHash(data)
    return plaintext
  }
}
