import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AccessInterface, AccessState } from '@core/types/access.js'
import { createAccessService, PORT_ATTEMPTS, type RunningListener } from './accessService.js'
import { createAccessStore, PAIRING_TTL_MS, type SecretBox } from './accessStore.js'
import { createKeepAwake } from './keepAwake.js'

describe('access service', () => {
  let dir: string
  let clock: number
  let log: string[]
  let broadcasts: AccessState[]
  let listens: number[]
  /** The ports that fail, and how. */
  let failing: Map<number, Error & { code?: string }>
  let connected: string[]
  let held: number[]
  let released: number[]
  let interfaces: AccessInterface[]
  let shields: boolean | undefined
  let shared: boolean

  const inUse = () => Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })

  function setup(secrets?: () => SecretBox | undefined) {
    const store = createAccessStore({ path: join(dir, 'access.json'), now: () => clock, secrets })
    const closed: number[] = []
    const service = createAccessService({
      store,
      listen: async (port) => {
        listens.push(port)
        const failure = failing.get(port)
        if (failure) throw failure
        const listener: RunningListener = {
          address: { address: '::', port },
          connectedDevices: () => connected,
          close: async () => void closed.push(port)
        }
        return listener
      },
      interfaces: () => interfaces,
      keepAwake: {
        hold: () => {
          held.push(held.length + 1)
          return held.length
        },
        release: (id: number) => void released.push(id)
      },
      broadcast: (state) => broadcasts.push(state),
      log: (message) => log.push(message),
      shieldsUp: async () => shields,
      workspaces: () => [{ id: 'default', name: 'Default', shared }]
    })
    return { store, service, closed }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'styr-access-'))
    clock = 1_000_000
    log = []
    broadcasts = []
    listens = []
    failing = new Map()
    connected = []
    held = []
    released = []
    interfaces = [
      { name: 'en0', address: '192.168.1.20', kind: 'lan' },
      { name: 'utun3', address: '100.101.102.103', kind: 'tailscale' }
    ]
    shields = undefined
    shared = true
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('opens no listener by default', async () => {
    const { service } = setup()
    await service.start()
    expect(listens).toEqual([])
    expect(service.state()).toMatchObject({ enabled: false, listening: false, port: 7878 })
  })

  it('never asks the keychain at startup or to show the state, and makes no key', async () => {
    // On macOS the keychain call blocks the main process before the window is up (v0.42.0).
    let asked = 0
    const { service, store } = setup(() => {
      asked++
      return { seal: (plain) => plain, open: (sealed) => sealed }
    })
    await service.start()
    expect(service.state().fingerprint).toBeUndefined()
    expect(broadcasts.every((state) => state.fingerprint === undefined)).toBe(true)
    expect(store.fingerprint()).toBeUndefined()
    expect(asked).toBe(0)
  })

  it('listens with one switch: nothing to pick', async () => {
    const { service } = setup()
    const state = await service.configure({ enabled: true })
    expect(listens).toEqual([7878])
    expect(state).toMatchObject({ enabled: true, listening: true, port: 7878 })
    expect(state.error).toBeUndefined()
    expect(state.interfaces.map((entry) => entry.address)).toEqual([
      '192.168.1.20',
      '100.101.102.103'
    ])
  })

  it('makes the key once switched on, and shows its fingerprint', async () => {
    const { service, store } = setup()
    const state = await service.configure({ enabled: true })
    expect(state.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(state.fingerprint).toBe(store.identity().fingerprint)
  })

  it('stays listening when the keychain will not seal the new key', async () => {
    const { service } = setup(() => ({
      seal: () => {
        throw new Error('locked')
      },
      open: () => ''
    }))
    const state = await service.configure({ enabled: true })
    expect(state).toMatchObject({ enabled: true, listening: true })
    expect(state.fingerprint).toBeUndefined()
  })

  it('moves to the next free port when the saved one is taken, and keeps it', async () => {
    failing.set(7878, inUse())
    failing.set(7879, inUse())
    const { service, store } = setup()
    const state = await service.configure({ enabled: true })
    expect(listens).toEqual([7878, 7879, 7880])
    expect(state).toMatchObject({ listening: true, port: 7880 })
    // Saved, so a paired device finds the computer there after a restart.
    expect(store.config().port).toBe(7880)
  })

  it('keeps the setting off and says why when no port is free', async () => {
    for (let port = 7878; port < 7878 + PORT_ATTEMPTS; port++) failing.set(port, inUse())
    const { service, store } = setup()
    const state = await service.configure({ enabled: true })
    expect(listens).toHaveLength(PORT_ATTEMPTS)
    expect(state).toMatchObject({ enabled: false, listening: false })
    expect(state.error).toMatch(/Ports 7878 to 7887 are all in use/)
    expect(store.config().enabled).toBe(false)
  })

  it('does not try other ports for any other failure, and never throws', async () => {
    failing.set(7878, Object.assign(new Error('nope'), { code: 'EACCES' }))
    const { service } = setup()
    const state = await service.configure({ enabled: true })
    expect(listens).toEqual([7878])
    expect(state.error).toMatch(/Not allowed to listen on port 7878/)
  })

  it('refuses a bad port', async () => {
    const { service } = setup()
    await expect(service.configure({ enabled: true, port: 80 })).rejects.toThrow(/port/)
    expect(listens).toEqual([])
  })

  it('reports Shields Up once checked, and checks when switched on', async () => {
    shields = true
    const { service } = setup()
    expect(service.state().shieldsUp).toBeUndefined()
    expect((await service.checkNetwork()).shieldsUp).toBe(true)
    shields = false
    await service.configure({ enabled: true })
    await Promise.resolve()
    expect(service.state().shieldsUp).toBe(false)
  })

  it('lists the workspaces and says whether any is shared', () => {
    shared = false
    const { service } = setup()
    expect(service.state()).toMatchObject({
      workspaces: [{ id: 'default', name: 'Default', shared: false }],
      workspaceShared: false
    })
    shared = true
    expect(service.refresh().workspaceShared).toBe(true)
  })

  it('closes on switch-off', async () => {
    const { service, closed } = setup()
    await service.configure({ enabled: true })
    await service.configure({ enabled: false })
    expect(closed).toEqual([7878])
    expect(service.state().listening).toBe(false)
  })

  it('listens again at startup when it was left on', async () => {
    const first = setup()
    await first.service.configure({ enabled: true, port: 7000 })
    const second = setup()
    await second.service.start()
    expect(listens.at(-1)).toBe(7000)
  })

  it('reads a config from before same-network access as switched off', async () => {
    // It listened on one Tailscale address; on now, it would take every network.
    writeFileSync(
      join(dir, 'access.json'),
      JSON.stringify({
        config: {
          enabled: true,
          bindAddress: '100.90.1.1',
          port: 7000,
          keepAwake: true,
          relay: { enabled: false, address: '', port: 7879 }
        },
        devices: [
          {
            id: 'dev1',
            name: 'iPhone',
            publicKey: 'a'.repeat(60),
            createdAt: '2026-01-01T00:00:00Z'
          }
        ]
      })
    )
    const { service, store } = setup()
    await service.start()
    expect(listens).toEqual([])
    expect(store.config()).toEqual({ enabled: false, port: 7000, keepAwake: true })
    // The devices stay paired.
    expect(service.state().devices.map((device) => device.id)).toEqual(['dev1'])
    // Once switched on again the old keys are gone from the file, so it stays on.
    await service.configure({ enabled: true })
    const again = setup()
    await again.service.start()
    expect(again.service.state()).toMatchObject({ enabled: true, listening: true })
  })

  it('refuses to pair while nothing listens', async () => {
    const { service } = setup()
    expect(() => service.pair()).toThrow(/Turn on Allow devices on your network/)
  })

  it('refuses to pair while this computer is on no network a device could reach', async () => {
    interfaces = []
    const { service, store } = setup()
    await service.configure({ enabled: true })
    expect(() => service.pair()).toThrow(/not on a network/)
    expect(store.pairing()).toBeUndefined()
  })

  it('pairs with a QR that carries every address, the fingerprint and a one-time secret', async () => {
    const { service, store } = setup()
    await service.configure({ enabled: true })
    const pairing = service.pair()
    const uri = new URL(pairing.uri)
    expect(uri.protocol).toBe('styr:')
    expect(uri.searchParams.get('v')).toBe('2')
    expect(uri.searchParams.get('host')).toBe('192.168.1.20')
    expect(uri.searchParams.get('hosts')).toBe('192.168.1.20,100.101.102.103')
    expect(uri.searchParams.get('port')).toBe('7878')
    expect(uri.searchParams.get('fp')).toBe(store.identity().fingerprint)
    expect(uri.searchParams.get('secret')).toBe(store.pairing()!.secret)
    expect(pairing.expiresAt).toBe(clock + PAIRING_TTL_MS)
    expect(pairing.modules.length).toBeGreaterThan(20)
    expect(pairing.modules.every((row) => row.length === pairing.modules.length)).toBe(true)
    // The secret is in the QR only, never in the state the screen gets.
    expect(JSON.stringify(service.state())).not.toContain(store.pairing()!.secret)
  })

  it('writes an IPv6 host with brackets', async () => {
    interfaces = [{ name: 'en0', address: 'fd12:3456::20', kind: 'lan' }]
    const { service } = setup()
    await service.configure({ enabled: true })
    const uri = new URL(service.pair().uri)
    expect(uri.searchParams.get('host')).toBe('[fd12:3456::20]')
    expect(uri.searchParams.get('hosts')).toBe('[fd12:3456::20]')
  })

  it('lists devices without verifiers, marks the connected ones and revokes', async () => {
    const { service, store } = setup()
    const device = store.addDevice('iPhone', 'a'.repeat(60))
    connected = [device.id]
    const state = service.state()
    expect(state.devices).toEqual([expect.objectContaining({ id: device.id, connected: false })])
    expect(JSON.stringify(state)).not.toContain('a'.repeat(60))
    await service.configure({ enabled: true })
    expect(service.state().devices[0]?.connected).toBe(true)
    expect(service.revoke(device.id).devices).toEqual([])
    expect(store.publicKeyFor(device.id)).toBeUndefined()
  })

  it('announces every change to the screen', async () => {
    const { service } = setup()
    await service.configure({ enabled: true })
    expect(broadcasts.length).toBeGreaterThan(0)
    expect(broadcasts.at(-1)?.listening).toBe(true)
  })

  it('holds the computer awake only while asked and while a device is connected', async () => {
    const { service } = setup()
    await service.configure({ enabled: true })
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
    await service.configure({ enabled: true, keepAwake: true })
    service.connections(1)
    await service.stop()
    expect(released).toEqual([1])
  })

  describe('requests to pair by approval', () => {
    const question = { name: 'Pixel 9', code: '482915', source: '192.168.1.77' }

    it('asks only while an Add device window is open, and one at a time', async () => {
      const { service } = setup()
      await service.configure({ enabled: true })
      expect(service.approvals.ask(question, () => undefined)).toBeUndefined()
      service.pair()
      expect(service.approvals.ask(question, () => undefined)).toBeDefined()
      expect(service.state().request).toMatchObject(question)
      expect(service.approvals.ask({ ...question, name: 'iPad' }, () => undefined)).toBeUndefined()
    })

    it('passes the answer on once, and a stale or repeated one allows nothing', async () => {
      const { service } = setup()
      await service.configure({ enabled: true })
      service.pair()
      const answers: boolean[] = []
      service.approvals.ask(question, (allow) => answers.push(allow))
      const id = service.state().request!.id
      expect(() => service.answer('someone-else', true)).toThrow(/no longer waiting/)
      expect(service.answer(id, true).request).toBeUndefined()
      expect(() => service.answer(id, true)).toThrow(/no longer waiting/)
      expect(answers).toEqual([true])
    })

    it('turns the request down when the window closes or access goes off', async () => {
      const { service } = setup()
      await service.configure({ enabled: true })
      service.pair()
      const answers: boolean[] = []
      service.approvals.ask(question, (allow) => answers.push(allow))
      service.cancelPairing()
      expect(answers).toEqual([false])
      expect(service.state().request).toBeUndefined()

      service.pair()
      service.approvals.ask(question, (allow) => answers.push(allow))
      await service.configure({ enabled: false })
      expect(answers).toEqual([false, false])
    })

    it('forgets a request the device withdrew, without answering it', async () => {
      const { service } = setup()
      await service.configure({ enabled: true })
      service.pair()
      const answers: boolean[] = []
      const asked = service.approvals.ask(question, (allow) => answers.push(allow))!
      asked.withdraw()
      expect(service.state().request).toBeUndefined()
      expect(answers).toEqual([])
      expect(broadcasts.at(-1)?.request).toBeUndefined()
    })
  })

  it.skipIf(process.platform === 'win32')('stores its file for the user only', async () => {
    const { service } = setup()
    await service.configure({ enabled: true })
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
