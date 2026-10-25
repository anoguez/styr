import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { build } from 'vite'
import { RpcPeer } from '@host/rpc/jsonRpc.js'
import type { Settings, Task, TerminalOutput, TerminalSessionInfo } from '@core/types.js'
import { TestPhone, type Credentials } from './networkFixture.js'

/**
 * Builds `styr serve` from this checkout and drives it over the network listener as a paired
 * phone would: pair from the QR, see nothing until a workspace is shared, then use the shared one
 * (a task, a terminal), lose it when it is unshared, and sign back in after the server restarts
 * with only the stored token. Skips where node-pty does not load, like `serve.integration.test.ts`.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const required = process.env.STYR_SERVER_INTEGRATION === '1'

function ptyLoads(): boolean {
  try {
    createRequire(import.meta.url)('node-pty')
    return true
  } catch (error) {
    if (required) throw error
    return false
  }
}

const enabled = process.platform !== 'win32' && ptyLoads()
const WAIT = { timeout: 15_000, interval: 25 }

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

describe.skipIf(!enabled)('styr serve --listen (integration)', { timeout: 60_000 }, () => {
  let home: string
  let socket: string
  let buildDir: string
  let port: number
  let server: ChildProcess | undefined
  let log = ''
  const phones: TestPhone[] = []

  function start(extra: string[]): void {
    log = ''
    server = spawn(
      process.execPath,
      [
        join(buildDir, 'out', 'server', 'index.mjs'),
        'serve',
        '--socket',
        socket,
        '--listen',
        `127.0.0.1:${port}`,
        ...extra
      ],
      {
        env: {
          PATH: '/usr/bin:/bin',
          HOME: home,
          STYR_HOME: join(home, '.styr')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    server.stdout!.on('data', (chunk) => (log += chunk))
    server.stderr!.on('data', (chunk) => (log += chunk))
  }

  async function stop(): Promise<void> {
    if (!server || server.exitCode !== null) return
    const exited = new Promise((resolve) => server!.once('exit', resolve))
    server.kill('SIGTERM')
    await exited
  }

  /** `styr serve <args>` as a second process, the way an operator runs the control commands. */
  function cli(...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [join(buildDir, 'out', 'server', 'index.mjs'), 'serve', ...args, '--socket', socket],
        { env: { PATH: '/usr/bin:/bin', HOME: home, STYR_HOME: join(home, '.styr') } }
      )
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.stderr.on('data', (chunk) => (err += chunk))
      child.on('exit', (code) => resolve({ code, out, err }))
    })
  }

  /** A client on the Unix socket: the desktop's own kind, which is never filtered. */
  async function local(): Promise<RpcPeer> {
    const connection = connect(socket)
    await new Promise<void>((resolve, reject) => {
      connection.once('connect', resolve)
      connection.once('error', reject)
    })
    const peer = new RpcPeer((line) => connection.write(line), {})
    connection.on('data', (chunk) => peer.receive(chunk))
    return peer
  }

  async function signIn(
    fingerprint: string,
    credentials: Credentials
  ): Promise<{ peer: RpcPeer; pushed: [string, unknown[]][]; phone: TestPhone }> {
    const phone = new TestPhone(port, fingerprint)
    phones.push(phone)
    await phone.opened()
    expect(await phone.authenticate(credentials)).toBe(true)
    return { ...phone.rpc(), phone }
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'styr-net-'))
    socket = join(home, 's.sock')
    port = await freePort()
    buildDir = join(ROOT, 'out', `.net-test-${process.pid}`)
    await build({
      configFile: join(ROOT, 'vite.server.config.mts'),
      root: ROOT,
      logLevel: 'error',
      build: { outDir: join(buildDir, 'out', 'server') }
    })
    const bin = join(home, 'bin')
    mkdirSync(bin)
    chmodSync(bin, 0o755)
    const storage = join(home, 'Styr')
    mkdirSync(storage, { recursive: true })
    writeFileSync(
      join(storage, 'settings.json'),
      JSON.stringify({ version: 1, shell: '/bin/bash', defaultRepoPath: home })
    )
  }, 60_000)

  afterAll(async () => {
    for (const phone of phones) phone.close()
    await stop()
    rmSync(buildDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('pairs, shares a workspace, works in it, loses it, and reconnects after a restart', async () => {
    start(['--pair'])
    await vi.waitFor(() => expect(log).toContain('styr://pair'), WAIT)
    const uri = new URL(/styr:\/\/pair\?\S+/.exec(log)![0])
    const fingerprint = uri.searchParams.get('fp')!
    expect(uri.searchParams.get('port')).toBe(String(port))

    // Pair once with the QR's secret.
    const pairing = new TestPhone(port, fingerprint)
    phones.push(pairing)
    await pairing.opened()
    const credentials = (await pairing.pair(uri.searchParams.get('secret')!, 'Test phone'))!
    expect(credentials).toBeDefined()
    pairing.close()

    // Nothing is shared: the phone lists nothing and every board channel is refused.
    const first = await signIn(fingerprint, credentials)
    await vi.waitFor(() => expect(first.pushed.map(([m]) => m)).toContain('server:hello'), WAIT)
    await expect(first.peer.request('workspaces:list', [])).resolves.toMatchObject({
      activeId: '',
      workspaces: []
    })
    for (const method of ['tasks:list', 'agents:list', 'terminal:list', 'orchestrate:plan']) {
      await expect(first.peer.request(method, [])).rejects.toThrow(/not shared/)
    }
    await expect(first.peer.request('remote:connect', ['h'])).rejects.toThrow()
    await expect(first.peer.request('workspaces:create', ['x'])).rejects.toThrow()

    // The desktop-side owner shares the workspace (the Unix socket is never filtered).
    const owner = await local()
    const settings = (await owner.request('settings:get', [])) as Settings
    await owner.request('settings:save', [
      {
        workspaceId: 'default',
        workspace: { ...settings, remoteAccess: true },
        global: settings
      }
    ])

    await expect(first.peer.request('workspaces:list', [])).resolves.toMatchObject({
      activeId: 'default',
      workspaces: [expect.objectContaining({ id: 'default' })]
    })
    const task = (await first.peer.request('tasks:create', [
      { title: 'From the phone', orchestrate: false }
    ])) as Task
    // The task is a file on the "Mac", and the owner's board sees it at once.
    const seen = (await owner.request('tasks:list', [])) as Task[]
    expect(seen.map((each) => each.id)).toContain(task.id)

    const session = (await first.peer.request('terminal:create', [
      { shell: '/bin/bash', title: 'phone shell' }
    ])) as TerminalSessionInfo
    const backlog = (await first.peer.request('terminal:attach', [
      session.id,
      80,
      24
    ])) as TerminalOutput
    expect(backlog).toHaveProperty('data')
    first.peer.notify('terminal:write', [session.id, 'echo from-the-phone\n'])
    await vi.waitFor(
      () =>
        expect(
          first.pushed
            .filter(([method]) => method === 'terminal:data')
            .map(([, [event]]) => (event as TerminalOutput).data)
            .join('')
        ).toContain('from-the-phone'),
      WAIT
    )
    await first.peer.request('terminal:detach', [session.id])

    // Unshare it from the phone itself: it is told, and its next call is refused.
    const current = (await first.peer.request('settings:get', [])) as Settings
    first.pushed.length = 0
    await owner.request('settings:save', [
      {
        workspaceId: 'default',
        workspace: { ...current, remoteAccess: false },
        global: current
      }
    ])
    await vi.waitFor(
      () =>
        expect(first.pushed.find(([method]) => method === 'settings:changed')?.[1][0]).toEqual({
          remoteAccess: false
        }),
      WAIT
    )
    await expect(first.peer.request('tasks:list', [])).rejects.toThrow(/not shared/)
    // The PTY keeps running for the owner.
    const live = (await owner.request('terminal:list', [])) as TerminalSessionInfo[]
    expect(live.map((each) => each.id)).toContain(session.id)
    first.phone.close()

    // The Mac's Styr restarts: no QR, the stored token is enough, every time.
    await stop()
    start([])
    await vi.waitFor(() => expect(log).toContain('listening on'), WAIT)
    for (let attempt = 0; attempt < 2; attempt++) {
      const again = await signIn(fingerprint, credentials)
      await expect(again.peer.request('workspaces:list', [])).resolves.toBeDefined()
      again.phone.close()
    }

    // The operator pairs a second device and removes the first, without restarting the server.
    const devices = await cli('devices')
    expect(devices.out).toContain('Test phone')
    const deviceId = devices.out.split(/\s+/)[0]!
    const second = await cli('pair')
    expect(second.code).toBe(0)
    expect(second.out).toMatch(/styr:\/\/pair\?\S+/)
    const online = await signIn(fingerprint, credentials)
    await expect(cli('revoke', 'nope')).resolves.toMatchObject({ code: 1 })
    expect((await cli('revoke', deviceId)).code).toBe(0)
    // Revoking ends the live connection at once, and the token is no good afterwards.
    expect((await online.phone.waitClosed()).code).toBe(4403)
    const refused = new TestPhone(port, fingerprint)
    phones.push(refused)
    await refused.opened()
    expect(await refused.authenticate(credentials)).toBe(false)
    expect((await cli('devices')).out).toContain('No paired devices')
  })
})
