import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verify, createPublicKey } from 'node:crypto'
import { createAccessStore, type SecretBox } from './accessStore.js'

describe('access store', () => {
  let dir: string
  let path: string
  const key = 'A'.repeat(60)
  const make = () => createAccessStore({ path, now: () => 1_000_000 })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'styr-store-'))
    path = join(dir, 'access.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps the same server key across restarts', () => {
    const first = make().identity().fingerprint
    expect(make().identity().fingerprint).toBe(first)
  })

  it('strips control characters from a device name', () => {
    const store = make()
    const device = store.addDevice('\u001b[2Jevil\u0007\nname', key)
    expect(device.name).toBe('[2Jevilname')
    expect(store.devices()[0]?.name).toBe('[2Jevilname')
  })

  it('does not lose its devices when the file cannot be read for a moment', () => {
    const store = make()
    const device = store.addDevice('iPhone', key)
    const saved = readFileSync(path, 'utf8')
    // A hand edit in progress: not valid JSON.
    writeFileSync(path, '{ "devices": [')
    store.reload()
    expect(store.hasDevice(device.id)).toBe(true)
    // Unreadable (a directory where the file should be) is the same.
    rmSync(path)
    writeFileSync(path, saved)
    chmodSync(path, 0o600)
    expect(store.hasDevice(device.id)).toBe(true)
    store.touch(device.id)
    expect(JSON.parse(readFileSync(path, 'utf8')).devices).toHaveLength(1)
  })

  it('treats a missing file as a fresh install', () => {
    expect(make().devices()).toEqual([])
  })

  it('sees a device another process removed, and does not bring it back', () => {
    const one = make()
    const device = one.addDevice('iPhone', key)
    const other = make()
    other.revoke(device.id)
    one.touch(device.id)
    expect(JSON.parse(readFileSync(path, 'utf8')).devices).toEqual([])
  })

  describe('the host key in the keychain', () => {
    /** A stand-in keychain: reversible, and visibly not the plaintext. */
    const keychain = (calls: string[] = []): SecretBox => ({
      seal: (plain) => {
        calls.push('seal')
        return `sealed:${Buffer.from(plain).reverse().toString('base64')}`
      },
      open: (sealed) => {
        calls.push('open')
        return Buffer.from(sealed.slice('sealed:'.length), 'base64').reverse().toString()
      }
    })
    const withKeychain = (box: SecretBox | undefined) =>
      createAccessStore({ path, now: () => 1_000_000, secrets: () => box })
    const saved = () => JSON.parse(readFileSync(path, 'utf8')).hostKey
    const signs = (store: ReturnType<typeof make>) => {
      const identity = store.identity()
      const signature = Buffer.from(identity.sign('data'), 'base64')
      const key = createPublicKey({
        key: Buffer.from(identity.publicKey, 'base64'),
        format: 'der',
        type: 'spki'
      })
      return verify(null, Buffer.from('data'), key, signature)
    }

    it('makes a new key sealed, with no plaintext in the file', () => {
      const store = withKeychain(keychain())
      expect(signs(store)).toBe(true)
      expect(saved().privateKey).toBeUndefined()
      expect(saved().sealedPrivateKey).toMatch(/^sealed:/)
      expect(signs(withKeychain(keychain()))).toBe(true)
    })

    it('seals a plaintext key from before, keeping the fingerprint', () => {
      const fingerprint = make().identity().fingerprint
      expect(saved().privateKey).toBeDefined()
      const store = withKeychain(keychain())
      store.sealHostKey()
      expect(saved().privateKey).toBeUndefined()
      expect(store.identity().fingerprint).toBe(fingerprint)
      expect(signs(store)).toBe(true)
    })

    it('opens the keychain once per process, and not to show the fingerprint', () => {
      withKeychain(keychain()).identity()
      const calls: string[] = []
      const store = withKeychain(keychain(calls))
      expect(store.identity().fingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect(calls).toEqual([])
      signs(store)
      signs(store)
      expect(calls).toEqual(['open'])
    })

    it('never replaces a key it cannot read', () => {
      const fingerprint = withKeychain(keychain()).identity().fingerprint
      const refusing = withKeychain({
        seal: () => 'x',
        open: () => {
          throw new Error('user denied')
        }
      })
      expect(() => refusing.identity().sign('data')).toThrow(/keychain: Error: user denied/)
      // Without a keychain (styr serve on the same machine) the key is out of reach, said so.
      const serve = withKeychain(undefined)
      expect(serve.identity().fingerprint).toBe(fingerprint)
      expect(() => serve.identity().sign('data')).toThrow(/desktop app's keychain/)
      expect(saved().sealedPrivateKey).toMatch(/^sealed:/)
    })

    it('keeps the key in the file, 0600, without a keychain', () => {
      const store = withKeychain(undefined)
      expect(signs(store)).toBe(true)
      expect(saved().privateKey).toBeDefined()
      expect(statSync(path).mode & 0o777).toBe(0o600)
    })
  })
})
