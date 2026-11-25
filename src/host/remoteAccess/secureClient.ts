import { randomBytes, sign, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import { fingerprintOf, signatureValid } from './handshake.js'
import { NoiseXX, generateNoiseKeyPair, type NoiseKeyPair } from './noise.js'
import {
  NOISE_PROLOGUE,
  SECURE_PROTOCOL,
  APPROVAL_NONCE_BYTES,
  approvalCode,
  approvalCommit,
  hostNonceSchema,
  SecureFrameChannel,
  decodeFrame,
  hostPayloadSchema,
  identitySignedData,
  securePairProof
} from './secureSession.js'

/**
 * The device's side of protocol 2 (`secureSession.ts`), as the phone runs it. The host uses none
 * of this; it is what the tests and the transcript vector drive the host with, and the reference
 * the Dart client is compared against.
 */

export interface SecureClientOptions {
  /**
   * SHA-256 of the host's identity key, from the QR or an earlier pairing. Required to sign in or
   * pair with a QR; a request (pairing by approval) to a host never met has none, and pins the key
   * the host shows once the person at the host allows it (`approval.hostFingerprint`).
   */
  pinnedFingerprint?: string
  /** The device's Ed25519 key pair; the public half is SPKI DER, base64. */
  identity: { privateKey: KeyObject; publicKey: string }
  signIn:
    | { type: 'auth'; deviceId: string }
    | { type: 'pair'; name: string; secret: string }
    | { type: 'request'; name: string }
  maxMessageBytes: number
  /** Tests only: fixed keys, for the transcript vector. */
  staticKey?: NoiseKeyPair
  ephemeralKey?: NoiseKeyPair
  /** Tests only: a fixed random value for a request's code. */
  deviceNonce?: Buffer
}

export class SecureHandshakeError extends Error {}

const utf8 = new TextDecoder('utf-8', { fatal: true })

export type SecureClientStep =
  | {
      kind: 'send'
      frames: string[]
      /**
       * After a request's reveal: the code to show, which the host shows too, and the host's
       * fingerprint. A device keeps the pairing only once it says `paired` AND the person here
       * confirms the codes matched: the host's Allow alone proves nothing to this side.
       */
      approval?: { code: string; hostFingerprint: string }
    }
  | { kind: 'pending' }
  | { kind: 'ready'; channel: SecureFrameChannel; deviceId?: string }

const statusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paired'), deviceId: z.string().min(1).max(100) }),
  z.object({ type: z.literal('ready') })
])

export function createSecureClientHandshake(options: SecureClientOptions) {
  const staticKey = options.staticKey ?? generateNoiseKeyPair()
  const noise = new NoiseXX({
    initiator: true,
    staticKey,
    prologue: NOISE_PROLOGUE,
    ephemeralKey: options.ephemeralKey
  })
  if (options.signIn.type !== 'request' && !options.pinnedFingerprint) {
    throw new SecureHandshakeError('signing in or pairing with a QR needs the host fingerprint')
  }
  let state: 'start' | 'challenge' | 'nonce' | 'status' | 'done' = 'start'
  /** A request's own random value, committed to in message 3 and revealed after the host's. */
  const deviceNonce =
    options.signIn.type === 'request'
      ? (options.deviceNonce ?? randomBytes(APPROVAL_NONCE_BYTES))
      : undefined
  let hostFingerprint = ''
  let channel: SecureFrameChannel | undefined
  let deviceId: string | undefined

  const fail = (why: string): never => {
    state = 'done'
    throw new SecureHandshakeError(why)
  }

  /** Checks the host before a byte about this device is sent: the pinned key, bound to this session. */
  function challenge(frame: string): SecureClientStep {
    let host: z.infer<typeof hostPayloadSchema>
    try {
      const { payload, hashBeforePayload } = noise.read(decodeFrame(frame))
      host = hostPayloadSchema.parse(JSON.parse(utf8.decode(payload)))
      // A request to a host never met has nothing to pin yet; its key is still checked to sign
      // this session, and the code shown on both screens is what proves nobody is in between.
      if (
        options.pinnedFingerprint !== undefined &&
        fingerprintOf(host.identityKey) !== options.pinnedFingerprint
      ) {
        return fail('the host is not the one this device paired with')
      }
      const signed = identitySignedData('host', noise.remoteStatic!, hashBeforePayload)
      if (!signatureValid(host.identityKey, signed, host.signature)) {
        return fail('the host is not the one this device paired with')
      }
    } catch (error) {
      if (error instanceof SecureHandshakeError) throw error
      return fail(`bad handshake message: ${String(error)}`)
    }
    const reply = noise.write((hash) => {
      const signature = sign(
        null,
        identitySignedData('device', staticKey.publicKey, hash),
        options.identity.privateKey
      ).toString('base64')
      const body =
        options.signIn.type === 'auth'
          ? { type: 'auth', deviceId: options.signIn.deviceId, signature }
          : options.signIn.type === 'request'
            ? {
                type: 'request',
                name: options.signIn.name,
                identityKey: options.identity.publicKey,
                signature,
                commit: approvalCommit(deviceNonce!)
              }
            : {
                type: 'pair',
                name: options.signIn.name,
                identityKey: options.identity.publicKey,
                signature,
                proof: securePairProof(
                  options.signIn.secret,
                  hash,
                  options.signIn.name,
                  options.identity.publicKey
                )
              }
      return Buffer.from(JSON.stringify(body))
    })
    channel = new SecureFrameChannel(noise.transport(), options.maxMessageBytes)
    hostFingerprint = fingerprintOf(host.identityKey)
    state = options.signIn.type === 'request' ? 'nonce' : 'status'
    return { kind: 'send', frames: [reply.toString('base64')] }
  }

  /** The host's random value: reveal this side's, and only now is there a code to show. */
  function nonce(frame: string): SecureClientStep {
    let hostNonce: Buffer
    try {
      const text = channel!.open(frame)
      if (text === undefined) return fail('expected the host’s value in one record')
      const parsed = hostNonceSchema.safeParse(JSON.parse(text))
      if (!parsed.success) return fail('expected the host’s value')
      hostNonce = Buffer.from(parsed.data.nonce, 'base64')
    } catch (error) {
      if (error instanceof SecureHandshakeError) throw error
      return fail(`bad message from the host: ${String(error)}`)
    }
    state = 'status'
    return {
      kind: 'send',
      frames: channel!.seal(
        JSON.stringify({ type: 'reveal', nonce: deviceNonce!.toString('base64') })
      ),
      approval: {
        code: approvalCode(channel!.handshakeHash, deviceNonce!, hostNonce),
        hostFingerprint
      }
    }
  }

  function status(frame: string): SecureClientStep {
    let text: string | undefined
    let parsed: unknown
    try {
      text = channel!.open(frame)
      if (text === undefined) return { kind: 'pending' }
      parsed = JSON.parse(text)
    } catch (error) {
      return fail(`bad status message: ${String(error)}`)
    }
    const message = statusSchema.safeParse(parsed)
    if (!message.success) return fail('expected paired or ready')
    if (message.data.type === 'paired') {
      deviceId = message.data.deviceId
      return { kind: 'pending' }
    }
    state = 'done'
    return { kind: 'ready', channel: channel!, deviceId }
  }

  return {
    /** The first frame. */
    start(): string {
      if (state !== 'start') return fail('already started')
      state = 'challenge'
      const first = noise.write()
      return JSON.stringify({
        type: 'hello',
        protocol: SECURE_PROTOCOL,
        noise: first.toString('base64')
      })
    },

    receive(frame: string): SecureClientStep {
      if (state === 'challenge') return challenge(frame)
      if (state === 'nonce') return nonce(frame)
      if (state === 'status') return status(frame)
      return fail('unexpected frame')
    }
  }
}
