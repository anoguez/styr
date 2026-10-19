import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createHub, PROTOCOL_VERSION } from './hub.js'
import { attach, isListening, listen, type Listener } from './socket.js'

// Unix sockets only: the server targets Linux, and runs on macOS for development.
describe.skipIf(process.platform === 'win32')('server socket', () => {
  let dir: string
  let path: string
  const open: Listener[] = []

  const hub = () =>
    createHub({
      invoke: { echo: { args: z.tuple([z.string()]), run: ((text: string) => text) as never } },
      send: {},
      info: () => ({
        protocol: PROTOCOL_VERSION,
        version: '1.2.3',
        pid: 1,
        startedAt: '',
        storageDir: '',
        platform: ''
      }),
      tray: () => ({ statuses: [], titles: {} }),
      terminals: { backlog: () => ({ data: '', sequence: 0, marks: [] }), resize: () => {} },
      pin: { current: () => undefined, clear: () => {} }
    })

  async function start(): Promise<Listener> {
    const listener = await listen(path, hub())
    open.push(listener)
    return listener
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'styr-sock-'))
    path = join(dir, 's.sock')
  })

  afterEach(async () => {
    for (const listener of open.splice(0)) await listener.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the socket readable and writable by the user only', async () => {
    await start()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    await expect(isListening(path)).resolves.toBe(true)
  })

  it('refuses to start beside a live server, and replaces a socket file left behind', async () => {
    await start()
    await expect(listen(path, hub())).rejects.toThrow('already running')
    await open.pop()!.close()
    writeFileSync(path, '')
    await start()
    await expect(isListening(path)).resolves.toBe(true)
  })

  it('refuses a path too long for a Unix socket', async () => {
    await expect(listen(join(dir, 'x'.repeat(120)), hub())).rejects.toThrow('too long')
  })

  it('removes the socket file on close', async () => {
    const listener = await start()
    await listener.close()
    open.pop()
    expect(() => statSync(path)).toThrow()
  })

  it('pipes stdio to the server: hello first, then answers, until stdin ends', async () => {
    await start()
    const input = new PassThrough()
    const output = new PassThrough()
    const errors = new PassThrough()
    let received = ''
    output.on('data', (chunk) => (received += chunk))
    const exit = attach(path, input, output, errors)

    input.write('{"jsonrpc":"2.0","id":1,"method":"echo","params":["hi"]}\n')
    await vi.waitFor(() => expect(received.trim().split('\n')).toHaveLength(2))
    const [hello, reply] = received
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(hello).toMatchObject({ method: 'server:hello', params: [{ version: '1.2.3' }] })
    expect(reply).toEqual({ jsonrpc: '2.0', id: 1, result: 'hi' })

    input.end()
    await expect(exit).resolves.toBe(0)
  })

  it('exits 2 and says so when no server is running', async () => {
    const errors = new PassThrough()
    let message = ''
    errors.on('data', (chunk) => (message += chunk))
    await expect(attach(path, new PassThrough(), new PassThrough(), errors)).resolves.toBe(2)
    expect(message).toContain(`no Styr server is running on ${path}`)
  })

  it('ends the pipe when the server goes away', async () => {
    const listener = await start()
    const output = new PassThrough()
    let received = ''
    output.on('data', (chunk) => (received += chunk))
    const exit = attach(path, new PassThrough(), output, new PassThrough())
    await vi.waitFor(() => expect(received).toContain('server:hello'))
    await listener.close()
    open.pop()
    await expect(exit).resolves.toBe(0)
  })
})
