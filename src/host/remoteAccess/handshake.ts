import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'

/**
 * What every network connection's handshake shares (`secureSession.ts` is the handshake itself,
 * protocol 2): its limits, and the Ed25519 checks on identity keys. `docs/architecture/remote-access.md`
 * has the wire.
 */

export const HANDSHAKE_MAX_BYTES = 2048
export const HANDSHAKE_TIMEOUT_MS = 10_000

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

/** Whether `signatureBase64` is the Ed25519 signature of `data` by `publicKeyBase64` (SPKI DER). */
export function signatureValid(
  publicKeyBase64: string,
  data: string | Buffer,
  signatureBase64: string
): boolean {
  try {
    return verify(
      null,
      typeof data === 'string' ? Buffer.from(data) : data,
      createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(signatureBase64, 'base64')
    )
  } catch {
    return false
  }
}

/** Stands in for a device that does not exist, so a miss costs the same as a bad signature. */
export const DUMMY_KEY = generateKeyPairSync('ed25519')
  .publicKey.export({ type: 'spki', format: 'der' })
  .toString('base64')

/** The fingerprint of a server key as the phone computes it from the challenge. */
export function fingerprintOf(publicKeyBase64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex')
}
