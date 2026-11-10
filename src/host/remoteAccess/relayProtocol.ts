import { z } from 'zod'
import { HANDSHAKE_MAX_BYTES } from './handshake.js'
import { SECURE_FRAME_MAX_CHARS } from './secureSession.js'

/**
 * The wire between `styr relay` and its endpoints (`docs/architecture/remote-access.md`, Relay).
 * The relay moves a phone's frames to its host and back without reading them: over a relay the
 * session is protocol 2 end to end, so a frame is one Noise message (or the hello that starts it).
 * The host's relay client imports this as well as the relay.
 */

export const DEFAULT_RELAY_PORT = 7879

/** `GET /host`: a host registers. `GET /phone/<fingerprint>`: a phone asks for that host. */
export const RELAY_HOST_PATH = '/host'
export const RELAY_PHONE_PREFIX = '/phone/'

/** A host key fingerprint: SHA-256 of its Ed25519 public key (SPKI DER), lowercase hex. */
export const FINGERPRINT = /^[0-9a-f]{64}$/

/**
 * A fingerprint as a person may paste it (upper case, `:` or spaces between bytes), lowercased and
 * stripped; undefined when it is not one.
 */
export function normaliseFingerprint(text: string): string | undefined {
  const plain = text.trim().toLowerCase().replace(/[:\s]/g, '')
  return FINGERPRINT.test(plain) ? plain : undefined
}

/** What the host signs (Ed25519, its identity key) to register: the relay's fresh nonce. */
export function relayRegistrationData(nonce: string): string {
  return `styr-relay-host-v1\n${nonce}`
}

/**
 * The largest frame a phone sends or receives through the relay: one protocol-2 record (the
 * handshake's frames are smaller). The relay holds the session to it without knowing more.
 */
export const RELAY_FRAME_MAX_CHARS = Math.max(SECURE_FRAME_MAX_CHARS, HANDSHAKE_MAX_BYTES)
/** A host message is one frame plus its envelope (`{"type":"frame","sessionId":…,"frame":…}`). */
export const RELAY_HOST_MESSAGE_MAX_CHARS = RELAY_FRAME_MAX_CHARS + 256

/** WebSocket close codes the relay uses (4000–4999 are for applications). */
export const RELAY_CLOSE = {
  BAD_REQUEST: 4400,
  /** A host whose registration signature is wrong. */
  UNAUTHORIZED: 4401,
  /** A host whose key is not on the relay's allow list, or was revoked. */
  NOT_ALLOWED: 4403,
  /** To a phone: the host is not connected. Said the same way whether or not it exists. */
  HOST_OFFLINE: 4404,
  TIMEOUT: 4408,
  /** To a host: the same key registered again on another socket, which takes over. */
  REPLACED: 4409,
  /** Too many sessions or connections, or a session fell too far behind. */
  BUSY: 4429
} as const

const sessionId = z.string().regex(/^[0-9a-f]{16}$/)
/** A close code an endpoint may pass to the other: a normal close or an application code. */
const closeCode = z.union([z.literal(1000), z.number().int().min(4000).max(4999)])

/** Relay → host, before anything else on `/host`. */
export const relayChallengeSchema = z.object({
  type: z.literal('challenge'),
  nonce: z.string().regex(/^[0-9a-f]{32}$/)
})

/** Host → relay, the answer to the challenge. */
export const relayRegisterSchema = z.object({
  type: z.literal('register'),
  /** The host's Ed25519 identity key, SPKI DER, base64. */
  hostKey: z.string().min(1).max(200),
  /** Ed25519 over `relayRegistrationData(nonce)`, base64. */
  signature: z.string().min(1).max(200)
})

/** Relay → host once registered, and from then on. */
export const relayToHostSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('registered') }),
  /** A phone asked for this host; frames for `sessionId` follow. */
  z.object({ type: z.literal('open'), sessionId }),
  /** A frame from the phone, as it sent it. */
  z.object({ type: z.literal('frame'), sessionId, frame: z.string().max(RELAY_FRAME_MAX_CHARS) }),
  /** The phone hung up, or the relay ended the session. */
  z.object({ type: z.literal('close'), sessionId })
])

/** Host → relay once registered. */
export const hostToRelaySchema = z.discriminatedUnion('type', [
  /** A frame for the phone, sent to it bare. */
  z.object({ type: z.literal('frame'), sessionId, frame: z.string().max(RELAY_FRAME_MAX_CHARS) }),
  /** Ends a session; the phone sees `code` (default 1000). */
  z.object({ type: z.literal('close'), sessionId, code: closeCode.optional() })
])

export type RelayToHost = z.infer<typeof relayToHostSchema>
export type HostToRelay = z.infer<typeof hostToRelaySchema>
