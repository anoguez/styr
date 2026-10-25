import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccessStore } from './accessStore.js'

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
})
