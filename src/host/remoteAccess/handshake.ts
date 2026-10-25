import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
  verify
} from 'node:crypto'
import { z } from 'zod'
import type { AccessStore } from './accessStore.js'

/**
 * The handshake that comes before the JSON-RPC session on a network connection. There is no TLS,
 * so nothing reusable is ever sent: each device has an Ed25519 key pair whose private half never
 * leaves it (the Mac stores the public key) and signs the nonces at sign-in, and the Mac proves
 * its identity with its own key pair, whose fingerprint the phone got in the QR.
 *
 *   C → S  {type:'hello', clientNonce}
 *   S → C  {type:'challenge', serverNonce, serverKey, signature}   (signed over both nonces)
 *   C → S  {type:'auth', deviceId, signature}                      paired device
 *      or  {type:'pair', name, publicKey, proof}                   first time, with the QR's secret
 *   S → C  {type:'ready'} (after 'paired' on a pairing), or {type:'error', code}
 *
 * `publicKey` is the device's Ed25519 public key (SPKI DER, base64); the pairing proof is an HMAC
 * keyed by the QR's secret, so capturing it cannot pair another device, and the sign-in signature
 * covers both nonces, so capturing it cannot sign in. `docs/architecture/remote-access.md` has the details.
 */

export const HANDSHAKE_MAX_BYTES = 2048
export const HANDSHAKE_TIMEOUT_MS = 10_000

const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`))

export const helloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.number().int().optional(),
  clientNonce: hex(32)
})
export const authSchema = z.object({
  type: z.literal('auth'),
  deviceId: z.string().min(1).max(100),
  signature: z.string().min(80).max(100)
})
export const pairSchema = z.object({
  type: z.literal('pair'),
  name: z.string().max(200),
  publicKey: z.string().min(40).max(100),
  proof: hex(64)
})

export function serverSignedData(clientNonce: string, serverNonce: string): string {
  return `styr-server-v1\n${clientNonce}\n${serverNonce}`
}

export function authSignedData(
  deviceId: string,
  serverNonce: string,
  clientNonce: string,
  fingerprint: string
): string {
  return `styr-auth-v1\n${deviceId}\n${serverNonce}\n${clientNonce}\n${fingerprint}`
}

export function pairProof(
  secret: string,
  serverNonce: string,
  clientNonce: string,
  fingerprint: string,
  name: string,
  publicKey: string
): string {
  return createHmac('sha256', secret)
    .update(`styr-pair-v1\n${serverNonce}\n${clientNonce}\n${fingerprint}\n${name}\n${publicKey}`)
    .digest('hex')
}

/** Whether `publicKeyBase64` is an Ed25519 public key (SPKI DER). */
export function validDevicePublicKey(publicKeyBase64: string): boolean {
  try {
    return (
      createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
        .asymmetricKeyType === 'ed25519'
    )
  } catch {
    return false
  }
}

function signatureValid(publicKeyBase64: string, data: string, signatureBase64: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(data),
      createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(signatureBase64, 'base64')
    )
  } catch {
    return false
  }
}

/** Stands in for a device that does not exist, so a miss costs the same as a bad signature. */
const DUMMY_KEY = generateKeyPairSync('ed25519')
  .publicKey.export({ type: 'spki', format: 'der' })
  .toString('base64')

/** The fingerprint of a server key as the phone computes it from the challenge. */
export function fingerprintOf(publicKeyBase64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex')
}

/** Checks a server's challenge: the key is the pinned one and it signed both nonces. */
export function serverChallengeValid(
  challenge: { serverNonce: string; serverKey: string; signature: string },
  clientNonce: string,
  pinnedFingerprint: string
): boolean {
  if (fingerprintOf(challenge.serverKey) !== pinnedFingerprint) return false
  try {
    return verify(
      null,
      Buffer.from(serverSignedData(clientNonce, challenge.serverNonce)),
      createPublicKey({
        key: Buffer.from(challenge.serverKey, 'base64'),
        format: 'der',
        type: 'spki'
      }),
      Buffer.from(challenge.signature, 'base64')
    )
  } catch {
    return false
  }
}

function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

export type HandshakeResult =
  | { kind: 'reply'; messages: object[] }
  | { kind: 'ready'; messages: object[]; deviceId: string; paired: boolean }
  | { kind: 'denied'; messages: object[]; reason: string }

/** One connection's handshake, driven by the text frames it receives. */
export function createServerHandshake(options: {
  store: AccessStore
  protocol: number
  random?: (bytes: number) => Buffer
}) {
  const random = options.random ?? randomBytes
  let state: 'hello' | 'auth' | 'done' = 'hello'
  let clientNonce = ''
  let serverNonce = ''
  const identity = options.store.identity()

  const deny = (reason: string): HandshakeResult => {
    state = 'done'
    // Every refusal says the same to the peer: it learns nothing about which part was wrong.
    return { kind: 'denied', reason, messages: [{ type: 'error', code: 'unauthorized' }] }
  }

  return {
    receive(text: string): HandshakeResult {
      if (state === 'done') return deny('message after the handshake ended')
      if (Buffer.byteLength(text) > HANDSHAKE_MAX_BYTES) return deny('handshake message too large')
      let message: unknown
      try {
        message = JSON.parse(text)
      } catch {
        return deny('handshake message is not JSON')
      }

      if (state === 'hello') {
        const hello = helloSchema.safeParse(message)
        if (!hello.success) return deny('expected hello')
        if (hello.data.protocol !== undefined && hello.data.protocol !== options.protocol) {
          state = 'done'
          return {
            kind: 'denied',
            reason: `protocol ${hello.data.protocol} is not ${options.protocol}`,
            messages: [{ type: 'error', code: 'protocol', protocol: options.protocol }]
          }
        }
        clientNonce = hello.data.clientNonce
        serverNonce = random(16).toString('hex')
        state = 'auth'
        return {
          kind: 'reply',
          messages: [
            {
              type: 'challenge',
              protocol: options.protocol,
              serverNonce,
              serverKey: identity.publicKey,
              signature: identity.sign(serverSignedData(clientNonce, serverNonce))
            }
          ]
        }
      }

      const auth = authSchema.safeParse(message)
      if (auth.success) {
        // A device removed from another process (the CLI) is gone for the next sign-in.
        options.store.reload()
        const publicKey = options.store.publicKeyFor(auth.data.deviceId)
        const good = signatureValid(
          publicKey ?? DUMMY_KEY,
          authSignedData(auth.data.deviceId, serverNonce, clientNonce, identity.fingerprint),
          auth.data.signature
        )
        if (!publicKey || !good) return deny('bad device signature')
        state = 'done'
        return {
          kind: 'ready',
          deviceId: auth.data.deviceId,
          paired: false,
          messages: [{ type: 'ready' }]
        }
      }

      const pair = pairSchema.safeParse(message)
      if (pair.success) {
        // The offer is spent by the attempt, so a wrong guess cannot be retried against it.
        const offer = options.store.consumePairing()
        if (!offer) return deny('no open pairing')
        const expected = pairProof(
          offer.secret,
          serverNonce,
          clientNonce,
          identity.fingerprint,
          pair.data.name,
          pair.data.publicKey
        )
        if (!equalHex(expected, pair.data.proof)) return deny('bad pairing proof')
        if (!validDevicePublicKey(pair.data.publicKey)) return deny('not an Ed25519 key')
        let device
        try {
          device = options.store.addDevice(pair.data.name, pair.data.publicKey)
        } catch (error) {
          return deny(error instanceof Error ? error.message : 'could not add the device')
        }
        state = 'done'
        return {
          kind: 'ready',
          deviceId: device.id,
          paired: true,
          messages: [{ type: 'paired', deviceId: device.id }, { type: 'ready' }]
        }
      }
      return deny('expected auth or pair')
    }
  }
}
