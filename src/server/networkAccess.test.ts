import { createServer } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccessStore } from '@host/remoteAccess/accessStore.js'
import { createNetworkAccess, forwardToHub } from './networkAccess.js'
import { networkHost, TestPhone } from './networkFixture.js'

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

const gateOf = (host: ReturnType<typeof networkHost>) => ({
  isOpen: (id: string) => host.state.shared.has(id),
  activeId: () => host.state.active,
  sessionWorkspace: (id: string) => ({
    exists: host.state.sessions.has(id),
    workspaceId: host.state.sessions.get(id)
  }),
  currentGlobal: () => host.state.global
})

describe('network access for a host', () => {
  let host: ReturnType<typeof networkHost>
  let held: number[]
  let released: number[]
  const open: { stop(): Promise<void> }[] = []

  function create() {
    const access = createNetworkAccess({
      hub: host.hub,
      gate: gateOf(host),
      keepAwake: {
        hold: () => {
          held.push(held.length + 1)
          return held.length
        },
        release: (id) => void released.push(id)
      },
      broadcast: () => {},
      log: (message) => host.state.log.push(message),
      store: createAccessStore({ path: host.storePath, now: () => host.state.clock })
    })
    open.push(access.service)
    return access
  }

  beforeEach(() => {
    host = networkHost()
    held = []
    released = []
  })
  afterEach(async () => {
    for (const service of open.splice(0)) await service.stop()
    host.cleanup()
  })

  it('opens no listening port while Remote access is off', async () => {
    const port = await freePort()
    const { service } = create()
    await service.start()
    expect(service.state().listening).toBe(false)
    // Nothing answers where it would have listened.
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(port, '127.0.0.1', resolve))
    await new Promise((resolve) => probe.close(resolve))
  })

  it('pairs from the QR once, then reconnects after a restart with only the stored token', async () => {
    const port = await freePort()
    const first = create()
    await first.service.configure({ enabled: true, bindAddress: '127.0.0.1', port })
    const uri = new URL(first.service.pair().uri)
    expect(uri.searchParams.get('port')).toBe(String(port))

    const phone = new TestPhone(port, uri.searchParams.get('fp')!)
    await phone.opened()
    const credentials = await phone.pair(uri.searchParams.get('secret')!, 'Pixel 9')
    expect(credentials).toBeDefined()
    phone.close()

    // The Mac's Styr is restarted: a new service over the same file, listening because it was left on.
    await first.service.stop()
    const second = create()
    await second.service.start()
    expect(second.service.state()).toMatchObject({ listening: true, enabled: true })

    for (let attempt = 0; attempt < 3; attempt++) {
      const again = new TestPhone(port, uri.searchParams.get('fp')!)
      await again.opened()
      await expect(again.authenticate(credentials!)).resolves.toBe(true)
      again.close()
    }

    // Revoke is the only way back to a QR.
    second.service.revoke(credentials!.deviceId)
    const refused = new TestPhone(port, uri.searchParams.get('fp')!)
    await refused.opened()
    await expect(refused.authenticate(credentials!)).resolves.toBe(false)
  })

  it('holds the Mac awake while a paired device is connected', async () => {
    const port = await freePort()
    const { service } = create()
    await service.configure({ enabled: true, bindAddress: '127.0.0.1', port, keepAwake: true })
    const uri = new URL(service.pair().uri)
    const phone = new TestPhone(port, uri.searchParams.get('fp')!)
    await phone.opened()
    await phone.pair(uri.searchParams.get('secret')!, 'iPad')
    await vi.waitFor(() => expect(held).toEqual([1]))
    phone.close()
    await vi.waitFor(() => expect(released).toEqual([1]))
  })

  it('shows a paired device as connected', async () => {
    const port = await freePort()
    const { service } = create()
    await service.configure({ enabled: true, bindAddress: '127.0.0.1', port })
    const uri = new URL(service.pair().uri)
    const phone = new TestPhone(port, uri.searchParams.get('fp')!)
    await phone.opened()
    await phone.pair(uri.searchParams.get('secret')!, 'iPad')
    await vi.waitFor(() => expect(service.state().devices[0]?.connected).toBe(true))
  })
})

describe('forwardToHub', () => {
  function fake() {
    const calls: string[] = []
    const hub = {
      broadcast: (channel: string) => calls.push(`broadcast ${channel}`),
      terminalData: (id: string, output: { data: string }) =>
        calls.push(`data ${id} ${output.data}`),
      terminalExited: (id: string) => calls.push(`exited ${id}`),
      refresh: () => calls.push('refresh')
    }
    return { calls, hub: hub as never }
  }

  it('sends terminal output only to the clients attached to it', () => {
    const { calls, hub } = fake()
    forwardToHub(hub, 'terminal:data', { id: 't1', data: 'x', sequence: 1, marks: [] })
    expect(calls).toEqual(['data t1 x'])
  })

  it('tells the hub a terminal ended, after the event', () => {
    const { calls, hub } = fake()
    forwardToHub(hub, 'terminal:exit', { id: 't1', exitCode: 0 })
    expect(calls).toEqual(['broadcast terminal:exit', 'exited t1'])
  })

  it('re-checks what devices hold after settings or workspaces change', () => {
    const { calls, hub } = fake()
    forwardToHub(hub, 'settings:changed', {})
    forwardToHub(hub, 'workspaces:changed')
    forwardToHub(hub, 'tasks:changed')
    expect(calls).toEqual([
      'broadcast settings:changed',
      'refresh',
      'broadcast workspaces:changed',
      'refresh',
      'broadcast tasks:changed'
    ])
  })
})
