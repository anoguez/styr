import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AccessState } from '@core/types/access.js'
import { createAccessService, type RunningListener } from './accessService.js'
import { createAccessStore, PAIRING_TTL_MS } from './accessStore.js'
import { createKeepAwake } from './keepAwake.js'

describe('access service', () => {
  let dir: string
  let clock: number
  let log: string[]
  let broadcasts: AccessState[]
  let listens: [string, number][]
  let failWith: (Error & { code?: string }) | undefined
  let connected: string[]
  let held: number[]
  let released: number[]

  function setup() {
    const store = createAccessStore({ path: join(dir, 'access.json'), now: () => clock })
    const closed: string[] = []
    const service = createAccessService({
      store,
      listen: async (address, port) => {
        listens.push([address, port])
        if (failWith) throw failWith
        const listener: RunningListener = {
          address: { address, port },
          connectedDevices: () => connected,
          close: async () => void closed.push(`${address}:${port}`)
        }
        return listener
      },
      interfaces: () => [{ name: 'en0', address: '100.101.102.103', kind: 'tailscale' }],
      keepAwake: {
        hold: () => {
          held.push(held.length + 1)
          return held.length
        },
        release: (id: number) => void released.push(id)
      },
      broadcast: (state) => broadcasts.push(state),
      log: (message) => log.push(message)
    })
    return { store, service, closed }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'styr-access-'))
    clock = 1_000_000
    log = []
    broadcasts = []
    listens = []
    failWith = undefined
    connected = []
    held = []
    released = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('opens no listener by default', async () => {
    const { service } = setup()
    await service.start()
    expect(listens).toEqual([])
    expect(service.state()).toMatchObject({ enabled: false, listening: false, bindAddress: '' })
  })

  it('listens once switched on with a private interface', async () => {
    const { service } = setup()
    const state = await service.configure({
      enabled: true,
      bindAddress: '100.101.102.103',
      port: 7878
    })
    expect(listens).toEqual([['100.101.102.103', 7878]])
    expect(state).toMatchObject({ enabled: true, listening: true })
    expect(state.error).toBeUndefined()
  })

  it('refuses to switch on with no interface, every interface or a public one, and stays off', async () => {
    const { service } = setup()
    for (const bindAddress of ['', '0.0.0.0', '::', '8.8.8.8', 'example.com']) {
      const state = await service.configure({ enabled: true, bindAddress })
      expect(state).toMatchObject({ enabled: false, listening: false })
      expect(state.error).toBeTruthy()
    }
    expect(listens).toEqual([])
  })

  it('refuses a bad port', async () => {
    const { service } = setup()
    const state = await service.configure({ enabled: true, bindAddress: '127.0.0.1', port: 80 })
    expect(state.enabled).toBe(false)
    expect(state.error).toMatch(/port/)
  })

  it('keeps the setting off and says why when the port is taken', async () => {
    const { service, store } = setup()
    failWith = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    const state = await service.configure({ enabled: true, bindAddress: '127.0.0.1', port: 7000 })
    expect(state).toMatchObject({ enabled: false, listening: false })
    expect(state.error).toBe('Port 7000 is already in use on 127.0.0.1.')
    expect(store.config().enabled).toBe(false)
  })

  it('says so when the interface is gone, and never throws', async () => {
    const { service } = setup()
    failWith = Object.assign(new Error('x'), { code: 'EADDRNOTAVAIL' })
    const state = await service.configure({ enabled: true, bindAddress: '100.64.9.9' })
    expect(state.error).toMatch(/not an address of this computer/)
  })

  it('restarts on another interface and closes on switch-off', async () => {
    const { service, closed } = setup()
    await service.configure({ enabled: true, bindAddress: '127.0.0.1', port: 7000 })
    await service.configure({ bindAddress: '100.101.102.103' })
    expect(listens).toEqual([
      ['127.0.0.1', 7000],
      ['100.101.102.103', 7000]
    ])
    expect(closed).toEqual(['127.0.0.1:7000'])
    await service.configure({ enabled: false })
    expect(closed).toEqual(['127.0.0.1:7000', '100.101.102.103:7000'])
    expect(service.state().listening).toBe(false)
  })

  it('listens again at startup when it was left on', async () => {
    const first = setup()
    await first.service.configure({ enabled: true, bindAddress: '127.0.0.1', port: 7000 })
    const second = setup()
    await second.service.start()
    expect(listens.at(-1)).toEqual(['127.0.0.1', 7000])
  })

  it('refuses to pair while nothing listens', async () => {
    const { service } = setup()
    expect(() => service.pair()).toThrow(/Turn on Remote access/)
  })

  it('pairs with a QR that carries the address, the fingerprint and a one-time secret', async () => {
    const { service, store } = setup()
    await service.configure({ enabled: true, bindAddress: '100.100.1.1', port: 7878 })
    const pairing = service.pair()
    const uri = new URL(pairing.uri)
    expect(uri.protocol).toBe('styr:')
    expect(uri.searchParams.get('host')).toBe('100.100.1.1')
    expect(uri.searchParams.get('port')).toBe('7878')
    expect(uri.searchParams.get('fp')).toBe(store.identity().fingerprint)
    expect(uri.searchParams.get('secret')).toBe(store.pairing()!.secret)
    expect(pairing.expiresAt).toBe(clock + PAIRING_TTL_MS)
    expect(pairing.modules.length).toBeGreaterThan(20)
    expect(pairing.modules.every((row) => row.length === pairing.modules.length)).toBe(true)
    // The long-lived token is not in the QR, nor in the state the screen gets.
    expect(JSON.stringify(service.state())).not.toContain(store.pairing()!.secret)
  })

  it('writes an IPv6 host with brackets', async () => {
    const { service } = setup()
    await service.configure({ enabled: true, bindAddress: 'fd7a:115c:a1e0::1', port: 7878 })
    expect(new URL(service.pair().uri).searchParams.get('host')).toBe('[fd7a:115c:a1e0::1]')
  })

  it('lists devices without verifiers, marks the connected ones and revokes', async () => {
    const { service, store } = setup()
    const device = store.addDevice('iPhone', 'a'.repeat(60))
    connected = [device.id]
    const state = service.state()
    expect(state.devices).toEqual([expect.objectContaining({ id: device.id, connected: false })])
    expect(JSON.stringify(state)).not.toContain('a'.repeat(60))
    await service.configure({ enabled: true, bindAddress: '127.0.0.1', port: 7000 })
    expect(service.state().devices[0]?.connected).toBe(true)
    expect(service.revoke(device.id).devices).toEqual([])
    expect(store.publicKeyFor(device.id)).toBeUndefined()
  })

  it('announces every change to the screen', async () => {
    const { service } = setup()
    await service.configure({ enabled: true, bindAddress: '127.0.0.1', port: 7000 })
    expect(broadcasts.length).toBeGreaterThan(0)
    expect(broadcasts.at(-1)?.listening).toBe(true)
  })

  it('holds the Mac awake only while asked and while a device is connected', async () => {
    const { service } = setup()
    await service.configure({ enabled: true, bindAddress: '127.0.0.1', port: 7000 })
    service.connections(1)
    expect(held).toEqual([])
    await service.configure({ keepAwake: true })
    expect(held).toEqual([1])
    service.connections(2)
    expect(held).toEqual([1])
    service.connections(0)
    expect(released).toEqual([1])
    service.connections(1)
    expect(held).toEqual([1, 2])
    await service.configure({ keepAwake: false })
    expect(released).toEqual([1, 2])
  })

  it('lets go of the hold when the listener stops', async () => {
    const { service } = setup()
    await service.configure({
      enabled: true,
      bindAddress: '127.0.0.1',
      port: 7000,
      keepAwake: true
    })
    service.connections(1)
    await service.stop()
    expect(released).toEqual([1])
  })

  // Windows has no POSIX file modes; its profile folder is already private to the user.
  it.skipIf(process.platform === 'win32')('stores its file for the user only', async () => {
    const { service } = setup()
    await service.configure({ enabled: true, bindAddress: '127.0.0.1', port: 7000 })
    expect(statSync(join(dir, 'access.json')).mode & 0o777).toBe(0o600)
  })
})

describe('keep awake', () => {
  it('reports whether it holds', () => {
    let next = 0
    const awake = createKeepAwake({ hold: () => ++next, release: () => {} })
    expect(awake.holding()).toBe(false)
    awake.enabled(true)
    awake.connections(1)
    expect(awake.holding()).toBe(true)
  })
})
