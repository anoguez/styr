import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteConnection, type ServerHello } from '@host/remote/connection.js'
import { createLanHosts } from '@host/remote/lanHosts.js'
import {
  closeReason,
  lanTransport,
  pairWithLink,
  parsePairLink,
  parseTarget,
  privateAddress,
  requestLanPairing,
  type LanCredentials
} from '@host/remote/lanLink.js'
import { createAccessStore } from '@host/remoteAccess/accessStore.js'
import type { AccessState } from '@core/types/access.js'
import { createNetworkAccess } from './networkAccess.js'
import { networkHost } from './networkFixture.js'

// The desktop as a device of another Styr on the network (`lanLink.ts`): pairing by approval
// with a real host (listener, hub, gate), then `RemoteConnection` over the LAN transport, exactly
// as the desktop runs it for an ssh host.

describe('another computer on the network', () => {
  let host: ReturnType<typeof networkHost>
  let access: ReturnType<typeof createNetworkAccess>
  /** Whether the person at the host allows the next request; undefined leaves it waiting. */
  let answer: boolean | undefined
  const asked: { name: string; code: string }[] = []
  const connections: RemoteConnection[] = []

  beforeEach(async () => {
    host = networkHost()
    answer = true
    asked.length = 0
    access = createNetworkAccess({
      hub: host.hub,
      gate: {
        isOpen: (id) => host.state.shared.has(id),
        activeId: () => host.state.active,
        sessionWorkspace: () => ({ exists: false }),
        currentGlobal: () => host.state.global,
        sourcesOf: () => []
      },
      keepAwake: { hold: () => 0, release: () => undefined },
      broadcast: (state: AccessState) => {
        if (!state.request || asked.some((entry) => entry.code === state.request!.code)) return
        asked.push({ name: state.request.name, code: state.request.code })
        if (answer !== undefined) {
          const { id } = state.request
          const allow = answer
          queueMicrotask(() => access.service.answer(id, allow))
        }
      },
      log: (message) => host.state.log.push(message),
      store: createAccessStore({ path: host.storePath, now: () => host.state.clock }),
      host: '127.0.0.1',
      interfaces: () => [{ name: 'en0', address: '192.168.1.20', kind: 'lan' }],
      takesRequests: true
    })
    await access.service.configure({ enabled: true, port: await freePort() })
  })

  afterEach(async () => {
    for (const connection of connections.splice(0)) connection.stop()
    await access.service.stop()
    host.cleanup()
  })

  const target = () => ({ address: '127.0.0.1', port: access.service.state().port })

  async function pairNow(): Promise<{ credentials: LanCredentials; code: string }> {
    access.service.pair()
    let code = ''
    const pairing = requestLanPairing(target(), 'Studio desktop', (shown) => (code = shown))
    const result = await pairing.result
    const store = createLanHosts({ path: join(host.dir, 'lan-hosts.json'), now: () => 0 })
    store.add(target(), 'Studio', result)
    return { credentials: store.credentials(result.fingerprint)!, code }
  }

  function connect(credentials: LanCredentials) {
    const events = {
      hello: undefined as ServerHello | undefined,
      errors: [] as string[],
      notifications: [] as string[]
    }
    const connection = new RemoteConnection(
      'studio-a1b2c3',
      {
        spawn: () => lanTransport(credentials, 'Studio'),
        setTimer: (run, ms) => setTimeout(run, ms),
        clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
        now: () => Date.now()
      },
      {
        state: (state) => {
          if (state.lastError) events.errors.push(state.lastError)
        },
        connected: (hello) => (events.hello = hello),
        disconnected: () => undefined,
        notification: (method) => events.notifications.push(method)
      }
    )
    connections.push(connection)
    connection.start()
    return { connection, events }
  }

  it('pairs by approval, the code shown here being the one shown there', async () => {
    const { credentials, code } = await pairNow()
    expect(code).toMatch(/^\d{6}$/)
    expect(asked).toEqual([{ name: 'Studio desktop', code }])
    expect(credentials.fingerprint).toBe(access.store.identity().fingerprint)
    expect(access.service.state().devices.map((device) => device.name)).toEqual(['Studio desktop'])
  })

  it('says why when the other computer turns the request down, and keeps nothing', async () => {
    answer = false
    access.service.pair()
    const pairing = requestLanPairing(target(), 'Studio desktop', () => undefined)
    await expect(pairing.result).rejects.toThrow(/did not allow this computer/)
    expect(access.service.state().devices).toEqual([])
  })

  it('says why when no Add device window is open there', async () => {
    const pairing = requestLanPairing(target(), 'Studio desktop', () => undefined)
    await expect(pairing.result).rejects.toThrow(/Open Settings → Connections → Add device there/)
    expect(asked).toEqual([])
  })

  it('connects as a remote host would, seeing only what the other computer shares', async () => {
    const { credentials } = await pairNow()
    const { connection, events } = connect(credentials)
    await vi.waitFor(() => expect(events.hello).toBeDefined())
    expect(connection.state().status).toBe('connected')
    // The gate applies: only the shared workspace is listed.
    const overview = (await connection.request('workspaces:list')) as {
      workspaces: { id: string }[]
    }
    expect(overview.workspaces.map((workspace) => workspace.id)).toEqual(['open'])
    // A channel the gate keeps from devices is refused, not answered.
    await expect(connection.request('server:experimental', [{}])).rejects.toThrow()
  })

  it('refuses a computer that is not the one it paired with, sending nothing', async () => {
    const { credentials } = await pairNow()
    const { events } = connect({ ...credentials, fingerprint: '0'.repeat(64) })
    await vi.waitFor(() =>
      expect(events.errors.join(' ')).toMatch(/not the computer this one paired with/)
    )
    expect(events.hello).toBeUndefined()
  })

  /** The host's clock, which the link's expiry is on. */
  const clock = () => ({ now: () => host.state.clock })

  /** Add device's link, with the addresses swapped for `targets` (the test host is on loopback). */
  function linkFor(targets: string[]) {
    const link = parsePairLink(access.service.pair().uri)!
    return { ...link, targets: targets.map((address) => ({ address, port: target().port })) }
  }

  it('pairs with a pair link, as a phone does with the QR: nobody asked, kept at once', async () => {
    // An address off the network is skipped without a packet; the next one answers.
    const pairing = pairWithLink(linkFor(['203.0.113.5', '127.0.0.1']), 'Studio desktop', clock())
    const { target: reached, pairing: result } = await pairing.result
    expect(reached.address).toBe('127.0.0.1')
    expect(asked).toEqual([])
    expect(result.fingerprint).toBe(access.store.identity().fingerprint)
    expect(access.service.state().devices.map((device) => device.name)).toEqual(['Studio desktop'])

    const store = createLanHosts({ path: join(host.dir, 'lan-hosts.json'), now: () => 0 })
    store.add(reached, 'Studio', result)
    const { events } = connect(store.credentials(result.fingerprint)!)
    await vi.waitFor(() => expect(events.hello).toBeDefined())
  })

  it('works once: a used link is refused, and says how to get a new one', async () => {
    const link = linkFor(['127.0.0.1'])
    await pairWithLink(link, 'Studio desktop', clock()).result
    await expect(pairWithLink(link, 'Laptop', clock()).result).rejects.toThrow(
      /already used, it expired/
    )
    expect(access.service.state().devices).toHaveLength(1)
  })

  it('sends nothing to a computer that is not the one in the link', async () => {
    const link = { ...linkFor(['127.0.0.1']), fingerprint: '0'.repeat(64) }
    await expect(pairWithLink(link, 'Studio desktop', clock()).result).rejects.toThrow(
      /not the computer that made this link/
    )
    expect(access.service.state().devices).toEqual([])
  })

  it('refuses an expired link before dialling', async () => {
    const link = linkFor(['127.0.0.1'])
    const late = pairWithLink(link, 'Studio desktop', { now: () => link.expiresAt })
    await expect(late.result).rejects.toThrow(/expired/)
  })

  it('says so when none of the link’s addresses is on this network', async () => {
    await expect(pairWithLink(linkFor(['203.0.113.5']), 'Studio', clock()).result).rejects.toThrow(
      /None of the link's addresses answered/
    )
  })

  it('is cut off when removed there, and says so', async () => {
    const { credentials } = await pairNow()
    const { events } = connect(credentials)
    await vi.waitFor(() => expect(events.hello).toBeDefined())
    access.service.revoke(credentials.deviceId)
    await vi.waitFor(() => expect(events.errors.join(' ')).toMatch(/removed this computer/))
  })
})

describe('lan targets', () => {
  it('reads an address, an optional port, brackets for IPv6', () => {
    expect(parseTarget('192.168.1.20')).toEqual({ address: '192.168.1.20', port: 7878 })
    expect(parseTarget(' 192.168.1.20:7900 ')).toEqual({ address: '192.168.1.20', port: 7900 })
    expect(parseTarget('[fd00::1]:7900')).toEqual({ address: 'fd00::1', port: 7900 })
    expect(parseTarget('fd00::1')).toEqual({ address: 'fd00::1', port: 7878 })
    expect(parseTarget('studio.local')).toEqual({ address: 'studio.local', port: 7878 })
    expect(parseTarget('')).toBeUndefined()
    expect(parseTarget('http://studio')).toBeUndefined()
    expect(parseTarget('a b')).toBeUndefined()
    expect(parseTarget('studio:99999')).toBeUndefined()
  })

  it('connects only within the network: private addresses, or names that resolve to one', async () => {
    const resolve = async (name: string) =>
      name === 'studio.local' ? ['203.0.113.9', '192.168.1.30'] : ['203.0.113.9']
    await expect(privateAddress('192.168.1.20', resolve)).resolves.toBe('192.168.1.20')
    await expect(privateAddress('[fd00::1]', resolve)).resolves.toBe('fd00::1')
    await expect(privateAddress('100.90.1.2', resolve)).resolves.toBe('100.90.1.2')
    // A name is checked by what it resolves to, and the private answer is the one dialled.
    await expect(privateAddress('studio.local', resolve)).resolves.toBe('192.168.1.30')
    await expect(privateAddress('8.8.8.8', resolve)).rejects.toThrow(
      /not on this computer's network/
    )
    await expect(privateAddress('example.com', resolve)).rejects.toThrow(/203\.0\.113\.9/)
    await expect(privateAddress('gone.local', async () => [])).rejects.toThrow(/could not be found/)
  })

  it('reads a pair link strictly', () => {
    const fp = 'ab'.repeat(32)
    const secret = 'cd'.repeat(20)
    const uri =
      `styr://pair?v=2&host=192.168.1.20&port=7878&hosts=${encodeURIComponent('192.168.1.20,[fd00::1],100.90.1.2')}` +
      `&fp=${fp}&secret=${secret}&exp=1700000000000`
    expect(parsePairLink(` ${uri} `)).toEqual({
      targets: ['192.168.1.20', 'fd00::1', '100.90.1.2'].map((address) => ({
        address,
        port: 7878
      })),
      fingerprint: fp,
      secret,
      expiresAt: 1700000000000
    })
    expect(parsePairLink('192.168.1.20')).toBeUndefined()
    expect(parsePairLink(uri.replace('v=2', 'v=1'))).toBeUndefined()
    expect(parsePairLink(uri.replace(fp, 'nothex'))).toBeUndefined()
    expect(parsePairLink(uri.replace(`secret=${secret}`, 'secret='))).toBeUndefined()
    expect(parsePairLink(uri.replace('port=7878', 'port=0'))).toBeUndefined()
    expect(parsePairLink(uri.replace('&exp=1700000000000', ''))).toBeUndefined()
    expect(
      parsePairLink(`styr://pair?v=2&port=7878&fp=${fp}&secret=${secret}&exp=1`)
    ).toBeUndefined()
  })

  it('names each close code', () => {
    expect(closeReason(4403, 'Studio')).toMatch(/removed this computer/)
    expect(closeReason(4429, 'Studio')).toMatch(/busy/)
    expect(closeReason(1006, 'Studio')).toMatch(/1006/)
  })
})

describe('lan hosts store', () => {
  const dir = () => networkHost().dir
  const pairing = {
    fingerprint: 'a'.repeat(64),
    deviceId: 'dev-1',
    // A real PKCS8 Ed25519 key, so `credentials` can read it back.
    privateKey: Buffer.from('302e020100300506032b657004220420' + '11'.repeat(32), 'hex')
  }

  it('seals the key with the keychain, and reads it back', () => {
    const path = join(dir(), 'lan-hosts.json')
    const box = {
      seal: (plain: string) => `sealed:${Buffer.from(plain).toString('hex')}`,
      open: (sealed: string) => Buffer.from(sealed.slice(7), 'hex').toString()
    }
    const store = createLanHosts({ path, now: () => 0, secrets: () => box })
    store.add({ address: '192.168.1.30', port: 7878 }, 'Studio', pairing)
    expect(store.list()).toEqual([
      {
        fingerprint: pairing.fingerprint,
        name: 'Studio',
        address: '192.168.1.30',
        port: 7878,
        pairedAt: new Date(0).toISOString()
      }
    ])
    // The key is not in the clear on disk, nor in what Settings gets.
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain(pairing.privateKey.toString('base64'))
    expect(JSON.stringify(store.list())).not.toContain('sealed')
    expect(store.credentials(pairing.fingerprint)).toMatchObject({ deviceId: 'dev-1' })
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('moves, replaces and forgets a computer', () => {
    const store = createLanHosts({ path: join(dir(), 'lan-hosts.json'), now: () => 0 })
    store.add({ address: '192.168.1.30', port: 7878 }, 'Studio', pairing)
    store.add({ address: '192.168.1.31', port: 7878 }, 'Studio again', pairing)
    expect(store.list().map((entry) => entry.name)).toEqual(['Studio again'])
    store.move(pairing.fingerprint, { address: '10.0.0.4', port: 7900 })
    expect(store.get(pairing.fingerprint)).toMatchObject({ address: '10.0.0.4', port: 7900 })
    expect(store.remove(pairing.fingerprint)).toBe(true)
    expect(store.list()).toEqual([])
    expect(store.credentials(pairing.fingerprint)).toBeUndefined()
  })
})

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}
