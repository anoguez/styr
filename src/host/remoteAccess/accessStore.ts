import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { AccessConfig } from '@core/types/access.js'

export type { AccessConfig }

/** How long a pairing QR can be scanned. */
export const PAIRING_TTL_MS = 2 * 60 * 1000
export const DEFAULT_ACCESS_PORT = 7878
export const MAX_DEVICES = 50

export const DEFAULT_ACCESS_CONFIG: AccessConfig = {
  enabled: false,
  bindAddress: '',
  port: DEFAULT_ACCESS_PORT,
  keepAwake: false
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
      keepAwake: z.boolean().default(false)
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
  hostKey: z.object({ publicKey: z.string(), privateKey: z.string() }).optional()
})

type StoreFile = z.infer<typeof fileSchema>

export interface ServerIdentity {
  /** SHA-256 of the public key (SPKI DER), hex: what the QR carries for the phone to pin. */
  fingerprint: string
  /** The public key, SPKI DER, base64: sent in the handshake. */
  publicKey: string
  sign(data: string): string
}

export interface PairingOffer {
  secret: string
  expiresAt: number
}

export interface AccessStorePorts {
  path: string
  now(): number
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
  let file = read() ?? fileSchema.parse({})
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
    // The pairing offer and an unsaved key are this process's own; only devices and config move.
    file = { ...latest, hostKey: latest.hostKey ?? file.hostKey }
  }

  function save(): void {
    mkdirSync(dirname(ports.path), { recursive: true, mode: 0o700 })
    const temp = `${ports.path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(file, null, 2), { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, ports.path)
  }

  function changed(): void {
    for (const listener of [...listeners]) listener()
  }

  function hostKey(): { publicKey: string; privateKey: string } {
    if (!file.hostKey) {
      const pair = generateKeyPairSync('ed25519')
      file = {
        ...file,
        hostKey: {
          publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
        }
      }
      save()
    }
    return file.hostKey!
  }

  function currentOffer(): PairingOffer | undefined {
    if (offer && offer.expiresAt <= ports.now()) offer = undefined
    return offer
  }

  return {
    config: (): AccessConfig => ({ ...file.config }),

    setConfig(patch: Partial<AccessConfig>): AccessConfig {
      file = { ...file, config: { ...file.config, ...patch } }
      save()
      changed()
      return { ...file.config }
    },

    /** Made on first use and kept, so a phone's pinned fingerprint holds across restarts. */
    identity(): ServerIdentity {
      const key = hostKey()
      const der = Buffer.from(key.publicKey, 'base64')
      const privateKey = createPrivateKey({
        key: Buffer.from(key.privateKey, 'base64'),
        format: 'der',
        type: 'pkcs8'
      })
      return {
        fingerprint: createHash('sha256').update(der).digest('hex'),
        publicKey: key.publicKey,
        sign: (data) => sign(null, Buffer.from(data), privateKey).toString('base64')
      }
    },

    reload,

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
