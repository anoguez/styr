import { sign, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import { fingerprintOf, signatureValid } from './handshake.js'
import { NoiseXX, generateNoiseKeyPair, type NoiseKeyPair } from './noise.js'
import {
  NOISE_PROLOGUE,
  SECURE_PROTOCOL,
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
  /** SHA-256 of the host's identity key, from the QR. */
  pinnedFingerprint: string
  /** The device's Ed25519 key pair; the public half is SPKI DER, base64. */
  identity: { privateKey: KeyObject; publicKey: string }
  signIn: { type: 'auth'; deviceId: string } | { type: 'pair'; name: string; secret: string }
  maxMessageBytes: number
  /** Tests only: fixed keys, for the transcript vector. */
  staticKey?: NoiseKeyPair
  ephemeralKey?: NoiseKeyPair
}

export class SecureHandshakeError extends Error {}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export type SecureClientStep =
  | { kind: 'send'; frames: string[] }
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
  let state: 'start' | 'challenge' | 'status' | 'done' = 'start'
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
      if (fingerprintOf(host.identityKey) !== options.pinnedFingerprint) {
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
    state = 'status'
    return { kind: 'send', frames: [reply.toString('base64')] }
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
      if (state === 'status') return status(frame)
      return fail('unexpected frame')
    }
  }
}
