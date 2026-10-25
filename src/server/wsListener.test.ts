import { generateKeyPairSync } from 'node:crypto'
import { createConnection } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { AccessStore } from '@host/remoteAccess/accessStore.js'
import { CLOSE, type NetworkListener } from './wsListener.js'
import { listenOnLoopback, networkHost, TestPhone, type Credentials } from './networkFixture.js'

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

describe('network listener', () => {
  let host: ReturnType<typeof networkHost>
  let store: AccessStore
  let listener: NetworkListener
  const phones: TestPhone[] = []

  async function start(): Promise<void> {
    store = host.store()
    listener = await listenOnLoopback(host, store)
  }

  const phone = (headers?: Record<string, string>): TestPhone => {
    const created = new TestPhone(listener.address.port, store.identity().fingerprint, { headers })
    phones.push(created)
    return created
  }

  /** Pairs a new device through the QR's secret. */
  async function pairDevice(name = 'iPhone'): Promise<Credentials> {
    const offer = store.startPairing()
    const device = phone()
    await device.opened()
    const credentials = await device.pair(offer.secret, name)
    device.close()
    return credentials!
  }

  beforeEach(async () => {
    host = networkHost()
    await start()
  })

  afterEach(async () => {
    for (const p of phones.splice(0)) p.close()
    await listener.close()
    host.cleanup()
  })

  it('pairs once with the QR secret and then signs in with the device token alone', async () => {
    const credentials = await pairDevice()
    expect(store.devices()).toHaveLength(1)
    expect(store.devices()[0]).not.toHaveProperty('verifier')

    const again = phone()
    await again.opened()
    await expect(again.authenticate(credentials)).resolves.toBe(true)
  })

  it('keeps working across a restart of the listener and the store, with no new QR', async () => {
    const credentials = await pairDevice()
    await listener.close()
    await start()
    for (let attempt = 0; attempt < 3; attempt++) {
      const device = phone()
      await device.opened()
      await expect(device.authenticate(credentials)).resolves.toBe(true)
      device.close()
    }
  })

  it('never puts the private key or the pairing secret on the wire', async () => {
    const offer = store.startPairing()
    const sent: string[] = []
    const record = (device: TestPhone): void => {
      const original = device.socket.send.bind(device.socket) as (data: string) => void
      device.socket.send = ((data: string) => {
        sent.push(String(data))
        original(data)
      }) as never
    }
    const device = phone()
    await device.opened()
    record(device)
    const credentials = await device.pair(offer.secret, 'Pixel')
    device.close()
    const again = phone()
    await again.opened()
    record(again)
    await expect(again.authenticate(credentials!)).resolves.toBe(true)
    expect(sent.length).toBeGreaterThan(2)
    for (const text of sent) {
      expect(text).not.toContain(credentials!.privateKey)
      expect(text).not.toContain(offer.secret)
    }
  })

  it('refuses a pairing secret twice, after it expires, and a wrong one', async () => {
    const offer = store.startPairing()
    const first = phone()
    await first.opened()
    await expect(first.pair(offer.secret, 'one')).resolves.toBeDefined()

    const second = phone()
    await second.opened()
    await expect(second.pair(offer.secret, 'two')).resolves.toBeUndefined()
    expect((await second.waitClosed()).code).toBe(CLOSE.UNAUTHORIZED)

    const expiring = store.startPairing()
    host.state.clock += 2 * 60 * 1000 + 1
    const late = phone()
    await late.opened()
    await expect(late.pair(expiring.secret, 'late')).resolves.toBeUndefined()

    store.startPairing()
    const wrong = phone()
    await wrong.opened()
    await expect(wrong.pair('f'.repeat(40), 'guess')).resolves.toBeUndefined()
    expect(store.devices()).toHaveLength(1)
    // The failed guess spent the open offer too.
    expect(store.pairing()).toBeUndefined()
  })

  it('refuses a wrong token, an unknown device and a revoked device before any hub traffic', async () => {
    const credentials = await pairDevice()
    await tick()
    const before = host.hub.clientCount()

    const wrongToken = phone()
    await wrongToken.opened()
    await expect(
      wrongToken.authenticate({
        ...credentials,
        privateKey: generateKeyPairSync('ed25519')
          .privateKey.export({ type: 'pkcs8', format: 'der' })
          .toString('base64')
      })
    ).resolves.toBe(false)
    expect((await wrongToken.waitClosed()).code).toBe(CLOSE.UNAUTHORIZED)

    const unknown = phone()
    await unknown.opened()
    await expect(unknown.authenticate({ ...credentials, deviceId: 'nope' })).resolves.toBe(false)

    store.revoke(credentials.deviceId)
    const revoked = phone()
    await revoked.opened()
    await expect(revoked.authenticate(credentials)).resolves.toBe(false)
    expect(host.hub.clientCount()).toBe(before)
  })

  it('does not send the server hello to a peer that has not signed in', async () => {
    const device = phone()
    await device.opened()
    device.send({ type: 'hello', clientNonce: 'a'.repeat(32) })
    const challenge = JSON.parse(await device.next())
    expect(challenge.type).toBe('challenge')
    expect(host.hub.clientCount()).toBe(0)
  })

  it('gives a sniffer nothing to sign in with: a captured sign-in or pairing cannot be replayed', async () => {
    const offer = store.startPairing()
    const sniffed: string[] = []
    const watch = (device: TestPhone): void => {
      const original = device.socket.send.bind(device.socket) as (data: string) => void
      device.socket.send = ((data: string) => {
        sniffed.push(String(data))
        original(data)
      }) as never
    }
    const pairing = phone()
    await pairing.opened()
    watch(pairing)
    const credentials = (await pairing.pair(offer.secret, 'victim'))!
    const signing = phone()
    await signing.opened()
    watch(signing)
    await signing.authenticate(credentials)

    // Replaying the captured pair and auth messages on new connections fails: the nonces differ.
    for (const captured of sniffed.filter((text) => /"type":"(pair|auth)"/.test(text))) {
      const attacker = phone()
      await attacker.opened()
      await attacker.hello()
      attacker.send(captured)
      expect((await attacker.waitClosed()).code).toBe(CLOSE.UNAUTHORIZED)
    }
    expect(store.devices()).toHaveLength(1)
  })

  it('refuses to pair a key that is not Ed25519', async () => {
    const offer = store.startPairing()
    const device = phone()
    await device.opened()
    await device.hello()
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64')
    device.send({
      type: 'pair',
      name: 'rsa',
      publicKey: rsa.slice(0, 90),
      proof: 'a'.repeat(64)
    })
    expect((await device.waitClosed()).code).toBe(CLOSE.UNAUTHORIZED)
    expect(offer).toBeDefined()
    expect(store.devices()).toHaveLength(0)
  })

  it('refuses a token from a different install (another key pair)', async () => {
    const credentials = await pairDevice()
    // The phone pins the fingerprint it was given; another install has another key.
    const impostor = new TestPhone(listener.address.port, '0'.repeat(64))
    phones.push(impostor)
    await impostor.opened()
    await expect(impostor.authenticate(credentials)).resolves.toBe(false)
  })

  it('ends a revoked device’s live connection', async () => {
    const credentials = await pairDevice()
    const device = phone()
    await device.opened()
    await device.authenticate(credentials)
    device.rpc()
    expect(listener.connections()).toBe(1)
    store.revoke(credentials.deviceId)
    const closed = await device.waitClosed()
    expect(closed.code).toBe(CLOSE.REVOKED)
    await tick()
    expect(listener.connections()).toBe(0)
    expect(host.hub.clientCount()).toBe(0)
  })

  it('answers the hub once signed in, filtered by the shared workspaces', async () => {
    const credentials = await pairDevice()
    const device = phone()
    await device.opened()
    await device.authenticate(credentials)
    const { peer, pushed } = device.rpc()
    await tick()
    expect(pushed[0]?.[0]).toBe('server:hello')
    const list = (await peer.request('workspaces:list', [])) as { workspaces: { id: string }[] }
    expect(list.workspaces.map((w) => w.id)).toEqual(['open'])
  })

  it('refuses a frame over the handshake limit before sign-in', async () => {
    const device = phone()
    await device.opened()
    device.send('x'.repeat(5000))
    expect((await device.waitClosed()).code).toBe(1009)
    expect(host.hub.clientCount()).toBe(0)
  })

  it('refuses a frame over the session limit after sign-in', async () => {
    const credentials = await pairDevice()
    const device = phone()
    await device.opened()
    await device.authenticate(credentials)
    device.rpc()
    device.socket.send(
      '{"jsonrpc":"2.0","method":"x","params":["' + 'a'.repeat(9 * 1024 * 1024) + '"]}'
    )
    expect((await device.waitClosed()).code).toBe(1009)
  })

  it('closes on binary frames, bad JSON and the wrong first message, and rate limits repeats', async () => {
    for (const bad of [Buffer.from([1, 2, 3]), 'not json', '{"type":"auth"}', '[]', '{}']) {
      const device = phone()
      await device.opened()
      device.socket.send(bad)
      const closed = await device.waitClosed()
      expect([CLOSE.UNAUTHORIZED, CLOSE.BAD_REQUEST]).toContain(closed.code)
    }
    // Five failures from this address: the next connection is turned away.
    const blocked = phone()
    await expect(blocked.opened()).rejects.toThrow('429')
    expect(host.state.log.some((line) => line.includes('too many failed attempts'))).toBe(true)
    expect(host.hub.clientCount()).toBe(0)
  })

  it('drops a peer that never finishes the handshake', async () => {
    await listener.close()
    store = host.store()
    const { startNetworkListener } = await import('./wsListener.js')
    const { createNetworkPolicy } = await import('@host/remoteAccess/gate.js')
    listener = await startNetworkListener(
      {
        hub: host.hub,
        store,
        policy: () =>
          createNetworkPolicy({
            isOpen: () => true,
            activeId: () => 'open',
            sessionWorkspace: () => ({ exists: false }),
            currentGlobal: () => ({}),
            sourcesOf: () => []
          }),
        protocol: 1,
        log: () => {},
        handshakeMs: 50
      },
      '127.0.0.1',
      0
    )
    const device = phone()
    await device.opened()
    expect((await device.waitClosed()).code).toBe(CLOSE.TIMEOUT)
  })

  it('refuses proxy headers, browser origins and unknown paths', async () => {
    const proxied = phone({ 'X-Forwarded-For': '8.8.8.8' })
    await expect(proxied.opened()).rejects.toThrow('400')
    const browser = phone({ Origin: 'https://evil.example' })
    await expect(browser.opened()).rejects.toThrow('403')
    const other = new WebSocket(`ws://127.0.0.1:${listener.address.port}/admin`)
    await new Promise<void>((resolve) => {
      other.on('error', () => resolve())
      other.on('unexpected-response', (_r, response) => {
        expect(response.statusCode).toBe(404)
        resolve()
      })
    })
  })

  it('answers a plain HTTP request with nothing useful', async () => {
    const response = await fetch(`http://127.0.0.1:${listener.address.port}/`)
    expect(response.status).toBe(426)
    expect(await response.text()).toBe('')
  })

  it('survives garbage on the raw socket', async () => {
    await new Promise<void>((resolve) => {
      const socket = createConnection(listener.address.port, '127.0.0.1', () => {
        socket.write(Buffer.from([0xff, 0xfe, 0x00, 0x10]))
        socket.write('GET / HTTP/1.1\r\n\r\n')
      })
      socket.on('close', () => resolve())
      socket.on('error', () => resolve())
      setTimeout(() => socket.destroy(), 100)
    })
    const credentials = await pairDevice()
    const device = phone()
    await device.opened()
    await expect(device.authenticate(credentials)).resolves.toBe(true)
  })

  it('reports connection counts for the keep-awake hold', async () => {
    const counts: number[] = []
    await listener.close()
    store = host.store()
    const { startNetworkListener } = await import('./wsListener.js')
    listener = await startNetworkListener(
      {
        hub: host.hub,
        store,
        policy: host.policy,
        protocol: 1,
        log: () => {},
        onConnections: (count) => counts.push(count)
      },
      '127.0.0.1',
      0
    )
    const credentials = await pairDevice()
    const device = phone()
    await device.opened()
    await device.authenticate(credentials)
    device.close()
    await tick(50)
    expect(counts).toEqual([1, 0, 1, 0])
  })

  describe('what the hub shows a signed-in device', () => {
    async function signedIn() {
      const credentials = await pairDevice()
      const device = phone()
      await device.opened()
      await device.authenticate(credentials)
      const rpc = device.rpc()
      await tick()
      rpc.pushed.length = 0
      return rpc
    }

    it('delivers board broadcasts only while the active workspace is shared', async () => {
      const { pushed } = await signedIn()
      host.hub.broadcast('tasks:changed')
      await tick()
      expect(pushed.map(([method]) => method)).toEqual(['tasks:changed'])
      pushed.length = 0
      host.state.shared.clear()
      for (const channel of [
        'tasks:changed',
        'agents:changed',
        'server:notify',
        'review:changed'
      ]) {
        host.hub.broadcast(channel, { title: 'secret' })
      }
      await tick()
      expect(pushed).toEqual([])
    })

    it('never leaks another workspace on any broadcast', async () => {
      const { pushed } = await signedIn()
      host.state.active = 'closed'
      host.hub.broadcast('server:tray', {
        statuses: [{ taskId: 'TASK-2', workspaceId: 'closed' }],
        titles: { 'closed:TASK-2': 'Secret' }
      })
      host.hub.broadcast('workspaces:activity', { activeId: 'closed', byWorkspace: { closed: {} } })
      host.hub.broadcast('workspaces:changed', {
        activeId: 'closed',
        workspaces: [{ id: 'closed', name: 'Secret' }]
      })
      host.hub.broadcast('terminal:runtimeState', { id: 't-closed' })
      host.hub.broadcast('terminal:exit', { id: 't-closed', exitCode: 0 })
      host.hub.broadcast('settings:changed', { shell: 'secret' })
      host.hub.broadcast('tasks:changed')
      await tick()
      expect(JSON.stringify(pushed)).not.toMatch(/Secret|secret|closed/)
    })

    it('streams terminal data only for attached, shared terminals', async () => {
      const { peer, pushed } = await signedIn()
      await peer.request('terminal:attach', ['t-open', 80, 24])
      await expect(peer.request('terminal:attach', ['t-closed', 80, 24])).rejects.toThrow(
        /not in a workspace shared/
      )
      host.hub.terminalData('t-open', { data: 'hello', sequence: 2, marks: [] })
      host.hub.terminalData('t-closed', { data: 'secret', sequence: 2, marks: [] })
      await tick()
      expect(pushed.map(([method, params]) => [method, (params[0] as { id: string }).id])).toEqual([
        ['terminal:data', 't-open']
      ])
    })

    it('detaches terminals when their workspace is unshared, and refuses the next call', async () => {
      const { peer, pushed } = await signedIn()
      await peer.request('terminal:attach', ['t-open'])
      host.state.shared.clear()
      host.hub.refresh()
      host.hub.terminalData('t-open', { data: 'after', sequence: 3, marks: [] })
      await tick()
      expect(pushed.filter(([method]) => method === 'terminal:data')).toEqual([])
      await expect(peer.request('tasks:list', [])).rejects.toThrow(/not shared/)
      expect(host.state.calls).not.toContain('kill t-open')
    })

    it('refuses desktop-only channels, app-level settings and other workspaces', async () => {
      const { peer } = await signedIn()
      await expect(peer.request('remote:connect', [])).rejects.toThrow(/Not available/)
      await expect(
        peer.request('server:experimental', [{ externalSources: true }])
      ).rejects.toThrow()
      await expect(peer.request('workspaces:create', ['x'])).rejects.toThrow()
      await expect(peer.request('workspaces:switch', ['closed'])).rejects.toThrow(/not shared/)
      await expect(
        peer.request('settings:save', [
          { workspaceId: 'open', workspace: {}, global: { storageDir: '/etc' } }
        ])
      ).rejects.toThrow(/desktop/)
      await peer.request('settings:save', [
        { workspaceId: 'open', workspace: {}, global: host.state.global }
      ])
      expect(host.state.calls.filter((call) => call.startsWith('save'))).toHaveLength(1)
      expect(host.state.calls).not.toContain('experimental')
    })

    it('hides the other workspaces’ terminals and tray rows in answers', async () => {
      const { peer } = await signedIn()
      expect(
        ((await peer.request('terminal:list', [])) as { id: string }[]).map((s) => s.id)
      ).toEqual(['t-open'])
      expect(JSON.stringify(await peer.request('server:tray', []))).not.toContain('Secret')
    })

    it('ignores writes to a terminal that is not shared', async () => {
      const { peer } = await signedIn()
      peer.notify('terminal:write', ['t-closed', 'rm -rf'])
      peer.notify('terminal:write', ['t-open', 'ls'])
      await tick()
      expect(host.state.calls).toEqual(['write t-open ls'])
    })
  })
})
