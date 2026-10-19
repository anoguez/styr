import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { RPC_ERRORS, RpcPeer } from '@host/rpc/jsonRpc.js'
import { createHub, PROTOCOL_VERSION, type HubPorts, type ServerInfo } from './hub.js'

const INFO: ServerInfo = {
  protocol: PROTOCOL_VERSION,
  version: '9.9.9',
  pid: 1,
  startedAt: '2026-10-17T00:00:00.000Z',
  storageDir: '/srv/Styr',
  platform: 'linux x64'
}

function setup(overrides: Partial<HubPorts> = {}) {
  const calls: string[] = []
  let pinned: string | undefined
  const ports: HubPorts = {
    invoke: {
      echo: { args: z.tuple([z.string(), z.string().optional()]), run: (...args) => args },
      later: { args: z.tuple([]), run: async () => 'done' },
      pinsAndForgets: {
        args: z.tuple([]),
        run: () => {
          pinned = 'other'
        }
      },
      pinsAcrossAwait: {
        args: z.tuple([]),
        run: async () => {
          await Promise.resolve()
          pinned = 'other'
        }
      }
    },
    send: {
      'terminal:write': {
        args: z.tuple([z.string(), z.string()]),
        run: ((id: string, data: string) => calls.push(`write ${id} ${data}`)) as never
      }
    },
    info: () => INFO,
    tray: () => ({ statuses: [], titles: { 'TASK-0001': 'Tray' } }),
    terminals: {
      backlog: (id) => ({ data: `backlog of ${id}`, sequence: 3, marks: [] }),
      resize: (id, cols, rows) => calls.push(`resize ${id} ${cols}x${rows}`)
    },
    pin: {
      current: () => pinned,
      clear: () => {
        pinned = undefined
      }
    },
    ...overrides
  }
  const hub = createHub(ports)

  /** A client: its peer, and everything the server pushed to it. */
  function client() {
    const pushed: [string, unknown[]][] = []
    const end: { peer?: RpcPeer } = {}
    // The hello goes out before this end's peer exists; it is tested on its own, so drop it.
    const connection = hub.connect((line) => end.peer?.receive(line))
    const peer = (end.peer = new RpcPeer((line) => connection.receive(line), {
      notification: (method, params) => pushed.push([method, params])
    }))
    return { peer, pushed, close: connection.close }
  }

  return { hub, client, calls, pin: () => pinned }
}

/** Lets the peer's queued replies resolve. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('hub', () => {
  it('greets each client with the server version on attach', () => {
    const lines: string[] = []
    const { hub } = setup()
    hub.connect((line) => lines.push(line))
    expect(JSON.parse(lines[0]!)).toEqual({
      jsonrpc: '2.0',
      method: 'server:hello',
      params: [INFO]
    })
  })

  it('answers server:info and the channel table, validating the arguments', async () => {
    const { client } = setup()
    const { peer } = client()
    await expect(peer.request('server:info')).resolves.toEqual(INFO)
    await expect(peer.request('server:tray')).resolves.toEqual({
      statuses: [],
      titles: { 'TASK-0001': 'Tray' }
    })
    await expect(peer.request('echo', ['a'])).resolves.toEqual(['a'])
    await expect(peer.request('later')).resolves.toBe('done')
    await expect(peer.request('echo', [1])).rejects.toMatchObject({
      code: RPC_ERRORS.INVALID_PARAMS
    })
    await expect(peer.request('missing')).rejects.toMatchObject({
      code: RPC_ERRORS.METHOD_NOT_FOUND
    })
  })

  it('reads a null argument as left out, as JSON sends an undefined one', async () => {
    const { client } = setup()
    const { peer } = client()
    await expect(peer.request('echo', ['a', null])).resolves.toEqual(['a', null])
    // `[undefined]` goes back as `[null]`: the handler saw undefined.
    const seen: unknown[] = []
    const { client: other } = setup({
      invoke: {
        echo: {
          args: z.tuple([z.string(), z.string().optional()]),
          run: ((...args: unknown[]) => seen.push(...args)) as never
        }
      }
    })
    await other().peer.request('echo', ['a', null])
    expect(seen).toEqual(['a', undefined])
  })

  it('sends a broadcast to every client', async () => {
    const { hub, client } = setup()
    const a = client()
    const b = client()
    hub.broadcast('tasks:changed')
    hub.broadcast('tasks:activate', 'TASK-0001')
    await flush()
    for (const { pushed } of [a, b]) {
      expect(pushed).toEqual([
        ['tasks:changed', []],
        ['tasks:activate', ['TASK-0001']]
      ])
    }
  })

  it('stops sending to a client once it closes', () => {
    const { hub, client } = setup()
    const a = client()
    client()
    a.close()
    hub.broadcast('tasks:changed')
    expect(a.pushed).toEqual([])
    expect(hub.clientCount()).toBe(1)
  })

  it('sends terminal data only to the clients attached to that terminal', async () => {
    const { hub, client } = setup()
    const a = client()
    const b = client()
    await expect(a.peer.request('terminal:attach', ['t1'])).resolves.toEqual({
      data: 'backlog of t1',
      sequence: 3,
      marks: []
    })
    hub.terminalData('t1', { data: 'hi', sequence: 4, marks: [] })
    hub.terminalData('t2', { data: 'other', sequence: 1, marks: [] })
    await a.peer.request('terminal:detach', ['t1'])
    hub.terminalData('t1', { data: 'after detach', sequence: 5, marks: [] })
    expect(a.pushed).toEqual([
      ['terminal:data', [{ id: 't1', data: 'hi', sequence: 4, marks: [] }]]
    ])
    expect(b.pushed).toEqual([])
  })

  it('lets any client type into a terminal', () => {
    const { client, calls } = setup()
    client().peer.notify('terminal:write', ['t1', 'ls\r'])
    client().peer.notify('terminal:write', ['t1', 'pwd\r'])
    expect(calls).toEqual(['write t1 ls\r', 'write t1 pwd\r'])
  })

  it('sizes the PTY to the client that focused it last', async () => {
    const { client, calls } = setup()
    const a = client()
    const b = client()
    // The first client to report a size owns the terminal until another focuses it.
    await a.peer.request('terminal:attach', ['t1', 80, 24])
    await b.peer.request('terminal:attach', ['t1', 120, 40])
    expect(calls).toEqual(['resize t1 80x24'])

    b.peer.notify('terminal:focus', ['t1'])
    expect(calls).toEqual(['resize t1 80x24', 'resize t1 120x40'])

    // A's window resizes while B has focus: remembered, not applied.
    a.peer.notify('terminal:resize', ['t1', 90, 30])
    expect(calls).toHaveLength(2)
    b.peer.notify('terminal:resize', ['t1', 100, 35])
    expect(calls.at(-1)).toBe('resize t1 100x35')

    a.peer.notify('terminal:focus', ['t1'])
    expect(calls.at(-1)).toBe('resize t1 90x30')
  })

  it('hands the size to the next client to resize once the owner leaves', () => {
    const { client, calls } = setup()
    const a = client()
    const b = client()
    a.peer.notify('terminal:resize', ['t1', 80, 24])
    b.peer.notify('terminal:resize', ['t1', 120, 40])
    expect(calls).toEqual(['resize t1 80x24'])
    a.close()
    b.peer.notify('terminal:resize', ['t1', 121, 40])
    expect(calls.at(-1)).toBe('resize t1 121x40')
  })

  it('forgets attachments and focus when the terminal exits', () => {
    const { hub, client, calls } = setup()
    const a = client()
    const b = client()
    a.peer.notify('terminal:resize', ['t1', 80, 24])
    void a.peer.request('terminal:attach', ['t1'])
    hub.terminalExited('t1')
    hub.terminalData('t1', { data: 'late', sequence: 9, marks: [] })
    b.peer.notify('terminal:resize', ['t1', 120, 40])
    expect(a.pushed).toEqual([])
    expect(calls.at(-1)).toBe('resize t1 120x40')
  })

  it('ignores a malformed one-way call and an unknown one', () => {
    const { client, calls } = setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { peer } = client()
    peer.notify('terminal:resize', ['t1', 'wide', 24])
    peer.notify('terminal:write', ['t1'])
    peer.notify('nothing:here', [])
    expect(calls).toEqual([])
    error.mockRestore()
  })

  it('clears a workspace pin a handler left set, when it returns and when it settles', async () => {
    const { client, pin } = setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { peer } = client()
    await peer.request('pinsAndForgets')
    expect(pin()).toBeUndefined()
    await peer.request('pinsAcrossAwait')
    await flush()
    expect(pin()).toBeUndefined()
    expect(error.mock.calls.map((call) => call[0])).toEqual([
      'Styr server: pinsAndForgets left workspace other pinned; cleared it.',
      'Styr server: pinsAcrossAwait left workspace other pinned; cleared it.'
    ])
    error.mockRestore()
  })

  it('closes every client', () => {
    const { hub, client } = setup()
    const a = client()
    const b = client()
    hub.closeAll()
    hub.broadcast('tasks:changed')
    expect(hub.clientCount()).toBe(0)
    expect([...a.pushed, ...b.pushed]).toEqual([])
  })
})
