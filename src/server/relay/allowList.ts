import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { FINGERPRINT } from '@host/remoteAccess/relayProtocol.js'

const fileSchema = z.object({
  version: z.literal(1).default(1),
  hosts: z
    .array(z.object({ fingerprint: z.string().regex(FINGERPRINT), addedAt: z.string() }))
    .default([])
})

export type AllowedHost = z.infer<typeof fileSchema>['hosts'][number]

export interface AllowList {
  has(fingerprint: string): boolean
  list(): AllowedHost[]
  /** Adds a host; false when it was already there. */
  allow(fingerprint: string): boolean
  /** Removes a host; false when it was not there. */
  revoke(fingerprint: string): boolean
  /** Picks up a hand edit of the file. An unreadable file keeps what was loaded. */
  reload(): void
}

/**
 * The hosts a relay forwards phones to, in one file only the user can read (`~/.styr/relay.json`,
 * mode 0600, written atomically). It holds fingerprints alone: no secret crosses the network to
 * enrol a host, which proves its key on every registration. A file that exists but cannot be read
 * stops the relay from starting, rather than start empty and later be written over.
 */
export function createAllowList(path: string, now: () => Date = () => new Date()): AllowList {
  let hosts = read() ?? fail()

  function read(): AllowedHost[] | undefined {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined
    }
    try {
      const parsed = fileSchema.safeParse(JSON.parse(text))
      return parsed.success ? parsed.data.hosts : undefined
    } catch {
      return undefined
    }
  }

  function fail(): never {
    throw new Error(`${path} cannot be read, so the relay will not start. Fix or remove the file.`)
  }

  /**
   * Before a change: picks up a hand edit since the last read, so it is kept rather than written
   * over, and refuses to write over a file that cannot be read now.
   */
  function latest(): void {
    const current = read()
    if (!current) throw new Error(`${path} cannot be read, so nothing is written over it. Fix it.`)
    hosts = current
  }

  function save(): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, hosts }, null, 2), { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, path)
  }

  return {
    has: (fingerprint) => hosts.some((host) => host.fingerprint === fingerprint),
    list: () => hosts.map((host) => ({ ...host })),
    allow(fingerprint) {
      if (!FINGERPRINT.test(fingerprint)) throw new Error(`Not a host fingerprint: ${fingerprint}`)
      latest()
      if (hosts.some((host) => host.fingerprint === fingerprint)) return false
      hosts = [...hosts, { fingerprint, addedAt: now().toISOString() }]
      save()
      return true
    },
    revoke(fingerprint) {
      latest()
      if (!hosts.some((host) => host.fingerprint === fingerprint)) return false
      hosts = hosts.filter((host) => host.fingerprint !== fingerprint)
      save()
      return true
    },
    reload() {
      hosts = read() ?? hosts
    }
  }
}
