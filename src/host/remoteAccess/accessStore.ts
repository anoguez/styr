import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject
} from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { AccessConfig, AccessConfigPatch } from '@core/types/access.js'
import { DEFAULT_RELAY_PORT } from './relayProtocol.js'

export type { AccessConfig }

/** How long a pairing QR can be scanned. */
export const PAIRING_TTL_MS = 2 * 60 * 1000
export const DEFAULT_ACCESS_PORT = 7878
export const MAX_DEVICES = 50

export const DEFAULT_ACCESS_CONFIG: AccessConfig = {
  enabled: false,
  bindAddress: '',
  port: DEFAULT_ACCESS_PORT,
  keepAwake: false,
  relay: { enabled: false, address: '', port: DEFAULT_RELAY_PORT }
}

export interface DeviceRecord {
  id: string
  name: string
  /**
   * The device's Ed25519 public key (SPKI DER, base64). The private half is made on the phone
   * and never reaches the Mac; the sign-in signature is checked against this.
   */
  publicKey: string
  createdAt: string
  lastSeenAt?: string
}

/** A device as the settings screen lists it: never the public key. */
export type DeviceView = Omit<DeviceRecord, 'publicKey'>

const fileSchema = z.object({
  config: z
    .object({
      enabled: z.boolean().default(false),
      bindAddress: z.string().max(100).default(''),
      port: z.number().int().default(DEFAULT_ACCESS_PORT),
      keepAwake: z.boolean().default(false),
      // Added with the relay client: a file from before it reads as relay off.
      relay: z
        .object({
          enabled: z.boolean().default(false),
          address: z.string().max(100).default(''),
          port: z.number().int().default(DEFAULT_RELAY_PORT)
        })
        .default(DEFAULT_ACCESS_CONFIG.relay)
    })
    .default(DEFAULT_ACCESS_CONFIG),
  devices: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        name: z.string().max(200),
        publicKey: z.string().min(40).max(100),
        createdAt: z.string(),
        lastSeenAt: z.string().optional()
      })
    )
    .max(MAX_DEVICES)
    .default([]),
  hostKey: z
    .object({
      publicKey: z.string(),
      /** PKCS8 DER, base64: only where no keychain is available (`styr serve`). */
      privateKey: z.string().optional(),
      /** The same, sealed by the OS keychain (`AccessStorePorts.secrets`). */
      sealedPrivateKey: z.string().optional()
    })
    .refine((key) => key.privateKey !== undefined || key.sealedPrivateKey !== undefined)
    .optional()
})

type StoreFile = z.infer<typeof fileSchema>

export interface ServerIdentity {
  /** SHA-256 of the public key (SPKI DER), hex: what the QR carries for the phone to pin. */
  fingerprint: string
  /** The public key, SPKI DER, base64: sent in the handshake. */
  publicKey: string
  sign(data: string): string
  /** Ed25519 over raw bytes (the protocol-2 identity signature). */
  signBytes(data: Buffer): Buffer
}

/**
 * The OS keychain, where the desktop keeps the host's private key (Electron `safeStorage`).
 * Both may throw: the keychain can be locked or refuse this app.
 */
export interface SecretBox {
  seal(plain: string): string
  open(sealed: string): string
}

export interface PairingOffer {
  secret: string
  expiresAt: number
}

export interface AccessStorePorts {
  path: string
  now(): number
  /**
   * Where the host's private key is sealed, asked each time the key is made or read (the desktop's
   * keychain is only there once the app is ready). Absent (`styr serve`), the key stays in the
   * file, 0600.
   */
  secrets?: () => SecretBox | undefined
}

/**
 * What remote access keeps on this computer, in one file only the user can read
 * (`<config dir>/remote-access.json`, mode 0600): the listener's settings, the paired devices'
 * public keys and this install's key pair. It is not in the settings, because those reach the
 * renderer and, over the wire, the clients.
 */
/** Drops C0 and C1 control characters. */
function stripControls(text: string): string {
  return [...text]
    .filter((char) => {
      const code = char.codePointAt(0)!
      return code > 0x1f && (code < 0x7f || code > 0x9f)
    })
    .join('')
}

export function createAccessStore(ports: AccessStorePorts) {
  const initial = read()
  let file = initial ?? fileSchema.parse({})
  /**
   * False while the file exists but could not be read (a hand edit, EMFILE, a newer format): the
   * empty stand-in must never be written over it, nor a new key made, which would lose the devices
   * and change the fingerprint every phone pinned.
   */
  let trusted = initial !== undefined
  let offer: PairingOffer | undefined
  const listeners = new Set<() => void>()
  const revokedListeners = new Set<(deviceId: string) => void>()

  /** The file's content; undefined when it exists but cannot be read now (a hand edit, EMFILE). */
  function read(): StoreFile | undefined {
    let text: string
    try {
      text = readFileSync(ports.path, 'utf8')
    } catch (error) {
      // A missing file is a fresh install; anything else may pass, so it must not look empty.
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? fileSchema.parse({}) : undefined
    }
    try {
      const parsed = fileSchema.safeParse(JSON.parse(text))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  /** Picks up another process's change to the file (a device removed with the CLI). */
  function reload(): void {
    const latest = read()
    // Unreadable right now: keep what this process knows rather than treat it as empty, which
    // would close every device and write an empty list over the real one.
    if (!latest) return
    if (!trusted) {
      trusted = true
      file = latest
      return
    }
    // The pairing offer and an unsaved key are this process's own; only devices and config move.
    file = { ...latest, hostKey: latest.hostKey ?? file.hostKey }
  }

  function save(): void {
    if (!trusted) reload()
    if (!trusted) {
      throw new Error(
        `${ports.path} cannot be read, so nothing is written over it. Fix or remove the file.`
      )
    }
    mkdirSync(dirname(ports.path), { recursive: true, mode: 0o700 })
    const temp = `${ports.path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(file, null, 2), { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, ports.path)
  }

  function changed(): void {
    for (const listener of [...listeners]) listener()
  }

  /** The host key's public half, made on first use. */
  function hostKey(): NonNullable<StoreFile['hostKey']> {
    if (!trusted) reload()
    if (!file.hostKey) {
      if (!trusted) save()
      const pair = generateKeyPairSync('ed25519')
      const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
      const box = ports.secrets?.()
      file = {
        ...file,
        hostKey: {
          publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          ...(box ? { sealedPrivateKey: box.seal(privateKey) } : { privateKey })
        }
      }
      save()
    }
    return file.hostKey!
  }

  let unsealed: { publicKey: string; key: KeyObject } | undefined
  /** A keychain that refused once is not asked again until restart: any peer can cause a sign. */
  let refused: Error | undefined

  /**
   * The private key, read once per process. A plaintext key from before the keychain is sealed and
   * the plaintext dropped. A key that cannot be read is an error, never a new key: that would change
   * the fingerprint every paired phone pinned.
   */
  function privateKey(): KeyObject {
    const key = hostKey()
    if (unsealed?.publicKey === key.publicKey) return unsealed.key
    const box = ports.secrets?.()
    let pkcs8: string
    if (key.privateKey !== undefined) {
      pkcs8 = key.privateKey
      if (box) {
        try {
          const sealedPrivateKey = box.seal(pkcs8)
          file = { ...file, hostKey: { publicKey: key.publicKey, sealedPrivateKey } }
          save()
        } catch {
          // The keychain would not take it: the key stays in the file, 0600, and still signs.
        }
      }
    } else if (box) {
      if (refused) throw refused
      try {
        pkcs8 = box.open(key.sealedPrivateKey!)
      } catch (error) {
        refused = new Error(
          `Could not read this computer's remote access key from the keychain: ${String(error)}`,
          { cause: error }
        )
        throw refused
      }
    } else {
      throw new Error(
        "This computer's remote access key is sealed in the desktop app's keychain, which this " +
          'process cannot read. Run remote access from the desktop app.'
      )
    }
    unsealed = {
      publicKey: key.publicKey,
      key: createPrivateKey({ key: Buffer.from(pkcs8, 'base64'), format: 'der', type: 'pkcs8' })
    }
    return unsealed.key
  }

  function currentOffer(): PairingOffer | undefined {
    if (offer && offer.expiresAt <= ports.now()) offer = undefined
    return offer
  }

  return {
    config: (): AccessConfig => ({ ...file.config, relay: { ...file.config.relay } }),

    /** Merges `patch`; its `relay`, when given, is merged into the saved one. */
    setConfig(patch: AccessConfigPatch): AccessConfig {
      const { relay, ...rest } = patch
      file = {
        ...file,
        config: { ...file.config, ...rest, relay: { ...file.config.relay, ...relay } }
      }
      save()
      changed()
      return { ...file.config, relay: { ...file.config.relay } }
    },

    /**
     * The fingerprint of the key already made, or undefined. Never makes one: a new key is sealed
     * by the keychain, which must not be asked at startup or to draw Settings (on macOS the call
     * blocks the main process, and on a CI runner it never returns).
     */
    fingerprint(): string | undefined {
      if (!trusted) reload()
      const publicKey = file.hostKey?.publicKey
      return publicKey === undefined
        ? undefined
        : createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex')
    },

    /** Made on first use and kept, so a phone's pinned fingerprint holds across restarts. */
    identity(): ServerIdentity {
      const der = Buffer.from(hostKey().publicKey, 'base64')
      return {
        fingerprint: createHash('sha256').update(der).digest('hex'),
        publicKey: hostKey().publicKey,
        // Unsealed only when something is signed, so showing the fingerprint never asks the keychain.
        sign: (data) => sign(null, Buffer.from(data), privateKey()).toString('base64'),
        signBytes: (data) => sign(null, data, privateKey())
      }
    },

    reload,

    /**
     * Seals a plaintext key from before the keychain now, rather than at the next sign-in. Best
     * effort: a keychain that refuses leaves the key as it was.
     */
    sealHostKey(): void {
      if (file.hostKey?.privateKey === undefined || !ports.secrets?.()) return
      try {
        privateKey()
      } catch {
        // Kept in the file; the next sign-in tries again.
      }
    },

    hasDevice: (deviceId: string): boolean => file.devices.some((device) => device.id === deviceId),

    devices: (): DeviceView[] =>
      file.devices.map(({ publicKey: _publicKey, ...device }) => ({ ...device })),

    publicKeyFor: (deviceId: string): string | undefined =>
      file.devices.find((device) => device.id === deviceId)?.publicKey,

    addDevice(name: string, publicKey: string): DeviceView {
      reload()
      if (file.devices.length >= MAX_DEVICES) {
        throw new Error('Too many paired devices. Remove one first.')
      }
      const device: DeviceRecord = {
        id: randomBytes(9).toString('hex'),
        // Control characters would reach the owner's terminal through `styr serve devices`.
        name: stripControls(name).trim().slice(0, 100) || 'Device',
        publicKey,
        createdAt: new Date(ports.now()).toISOString()
      }
      file = { ...file, devices: [...file.devices, device] }
      save()
      changed()
      const { publicKey: _publicKey, ...view } = device
      return view
    },

    touch(deviceId: string): void {
      reload()
      const at = new Date(ports.now()).toISOString()
      file = {
        ...file,
        devices: file.devices.map((device) =>
          device.id === deviceId ? { ...device, lastSeenAt: at } : device
        )
      }
      save()
      changed()
    },

    revoke(deviceId: string): boolean {
      reload()
      if (!file.devices.some((device) => device.id === deviceId)) return false
      file = { ...file, devices: file.devices.filter((device) => device.id !== deviceId) }
      save()
      for (const listener of [...revokedListeners]) listener(deviceId)
      changed()
      return true
    },

    /** A new secret for one QR, replacing any earlier one. */
    startPairing(): PairingOffer {
      offer = { secret: randomBytes(20).toString('hex'), expiresAt: ports.now() + PAIRING_TTL_MS }
      changed()
      return offer
    },

    cancelPairing(): void {
      if (!offer) return
      offer = undefined
      changed()
    },

    /** The open offer, if it has not expired. */
    pairing: currentOffer,

    /** Spends the offer: a secret works once, whether or not the pairing then succeeds. */
    consumePairing(): PairingOffer | undefined {
      const open = currentOffer()
      offer = undefined
      return open
    },

    onChange(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    onRevoked(listener: (deviceId: string) => void): () => void {
      revokedListeners.add(listener)
      return () => revokedListeners.delete(listener)
    }
  }
}

export type AccessStore = ReturnType<typeof createAccessStore>
