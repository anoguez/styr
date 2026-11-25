import { createPrivateKey } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { LanHostInfo } from '@core/types/remote.js'
import type { SecretBox } from '../remoteAccess/accessStore.js'
import type { LanCredentials, LanPairing, LanTarget } from './lanLink.js'

/**
 * The other computers this desktop has paired with as a device (`lanLink.ts`):
 * `~/.styr/lan-hosts.json`, mode 0600, written atomically. A remote workspace's stub names one by
 * its fingerprint only (`RemoteWorkspaceLink.lan`), so no key ever sits in a workspace folder.
 * Each private key is sealed with the OS keychain where there is one, as the host key is.
 */

const entrySchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().min(1).max(100),
  address: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  deviceId: z.string().min(1).max(100),
  /** PKCS8 DER, base64: sealed by the keychain (`sealed`) or, without one, plain. */
  privateKey: z.object({ sealed: z.string().optional(), plain: z.string().optional() }),
  pairedAt: z.string()
})
const fileSchema = z.object({ hosts: z.array(entrySchema).max(50).default([]) })
type Entry = z.infer<typeof entrySchema>

export interface LanHostsPorts {
  path: string
  now(): number
  /** The OS keychain, asked each time a key is sealed or opened; absent or undefined: none. */
  secrets?: () => SecretBox | undefined
}

export function createLanHosts(ports: LanHostsPorts) {
  function read(): Entry[] {
    let text: string
    try {
      text = readFileSync(ports.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const parsed = fileSchema.safeParse(JSON.parse(text))
    if (!parsed.success) {
      throw new Error(`${ports.path} cannot be read, so nothing is written over it.`)
    }
    return parsed.data.hosts
  }

  function write(hosts: Entry[]): void {
    mkdirSync(dirname(ports.path), { recursive: true, mode: 0o700 })
    const temp = `${ports.path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ hosts }, null, 2), { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, ports.path)
  }

  const info = (entry: Entry): LanHostInfo => ({
    fingerprint: entry.fingerprint,
    name: entry.name,
    address: entry.address,
    port: entry.port,
    pairedAt: entry.pairedAt
  })

  return {
    list: (): LanHostInfo[] => read().map(info),

    get: (fingerprint: string): LanHostInfo | undefined => {
      const entry = read().find((host) => host.fingerprint === fingerprint)
      return entry ? info(entry) : undefined
    },

    /** The key and address to sign in with; throws when the keychain will not give the key up. */
    credentials(fingerprint: string): LanCredentials | undefined {
      const entry = read().find((host) => host.fingerprint === fingerprint)
      if (!entry) return undefined
      const { sealed, plain } = entry.privateKey
      let der: string
      if (sealed !== undefined) {
        const box = ports.secrets?.()
        if (!box) throw new Error('The keychain that holds this computer’s key is not available.')
        der = box.open(sealed)
      } else if (plain !== undefined) der = plain
      else throw new Error('No key is stored for this computer.')
      return {
        address: entry.address,
        port: entry.port,
        fingerprint: entry.fingerprint,
        deviceId: entry.deviceId,
        privateKey: createPrivateKey({
          key: Buffer.from(der, 'base64'),
          format: 'der',
          type: 'pkcs8'
        })
      }
    },

    /** Keeps what a pairing gave, replacing an earlier pairing with the same computer. */
    add(target: LanTarget, name: string, pairing: LanPairing): LanHostInfo {
      const der = pairing.privateKey.toString('base64')
      const box = ports.secrets?.()
      let privateKey: Entry['privateKey'] = { plain: der }
      if (box) {
        try {
          privateKey = { sealed: box.seal(der) }
        } catch {
          // A keychain that refuses: the file is still the user's alone (0600), as for the host key.
        }
      }
      const entry: Entry = {
        fingerprint: pairing.fingerprint,
        name: name.trim().slice(0, 100) || target.address,
        address: target.address,
        port: target.port,
        deviceId: pairing.deviceId,
        privateKey,
        pairedAt: new Date(ports.now()).toISOString()
      }
      write([...read().filter((host) => host.fingerprint !== entry.fingerprint), entry])
      return info(entry)
    },

    /** The computer moved (a new address from the network): sign in there from now on. */
    move(fingerprint: string, target: LanTarget): void {
      write(
        read().map((host) => (host.fingerprint === fingerprint ? { ...host, ...target } : host))
      )
    },

    /** Forgets a computer and its key. Its workspaces' stubs stay, unable to connect. */
    remove(fingerprint: string): boolean {
      const hosts = read()
      const kept = hosts.filter((host) => host.fingerprint !== fingerprint)
      if (kept.length === hosts.length) return false
      write(kept)
      return true
    }
  }
}

export type LanHosts = ReturnType<typeof createLanHosts>
