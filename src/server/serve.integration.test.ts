import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { build } from 'vite'
import { RpcPeer } from '@host/rpc/jsonRpc.js'
import type { ServerInfo } from './hub.js'
import type { Settings, Task, TerminalOutput, TerminalSessionInfo } from '@core/types.js'

/**
 * Builds `styr serve` from this checkout, runs it under plain Node on a temporary socket and
 * home (no ssh), and drives it over the socket as the desktop client will: a task launch, a
 * terminal attach → detach → reattach with its backlog, the PTY size following focus across two
 * clients, and an Auto-run pass.
 *
 * It needs a node-pty that loads under plain Node. CI's check job installs without scripts, so
 * node-pty is not built there and this skips; the smoke job installs it and runs this with
 * `STYR_SERVER_INTEGRATION=1`, which turns the skip into a failure.
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

// The server targets Linux (and runs on macOS for development); Windows has no Unix sockets here.
const enabled = process.platform !== 'win32' && ptyLoads()

const WAIT = { timeout: 15_000, interval: 25 }

interface Client {
  peer: RpcPeer
  events: [string, unknown[]][]
  hello: () => ServerInfo | undefined
  /** Everything this client received of one terminal's output. */
  output(id: string): string
  close(): void
}

describe.skipIf(!enabled)('styr serve (integration)', { timeout: 30_000 }, () => {
  let home: string
  let socket: string
  let buildDir: string
  let server: ChildProcess
  let serverLog = ''
  const clients: Client[] = []

  async function client(): Promise<Client> {
    const connection = connect(socket)
    await new Promise<void>((resolve, reject) => {
      connection.once('connect', resolve)
      connection.once('error', reject)
    })
    const events: [string, unknown[]][] = []
    const peer = new RpcPeer((line) => connection.write(line), {
      notification: (method, params) => events.push([method, params])
    })
    connection.on('data', (chunk) => peer.receive(chunk))
    connection.on('close', () => peer.close())
    const made: Client = {
      peer,
      events,
      hello: () => events.find(([method]) => method === 'server:hello')?.[1][0] as ServerInfo,
      output: (id) =>
        events
          .filter(
            ([method, [event]]) => method === 'terminal:data' && (event as { id: string }).id === id
          )
          .map(([, [event]]) => (event as TerminalOutput).data)
          .join(''),
      close: () => connection.destroy()
    }
    clients.push(made)
    await vi.waitFor(() => expect(made.hello()).toBeDefined(), WAIT)
    return made
  }

  const call = <T>(on: Client, method: string, ...params: unknown[]): Promise<T> =>
    on.peer.request(method, params) as Promise<T>

  beforeAll(async () => {
    // Short: a Unix socket path has to fit in about 100 bytes.
    home = mkdtempSync(join(tmpdir(), 'styr-serve-'))
    socket = join(home, 's.sock')
    // Inside the checkout, so the build's external native modules resolve from its node_modules.
    buildDir = join(ROOT, 'out', `.serve-test-${process.pid}`)
    await build({
      configFile: join(ROOT, 'vite.server.config.mts'),
      root: ROOT,
      logLevel: 'error',
      build: { outDir: join(buildDir, 'out', 'server') }
    })

    // A stand-in agent CLI: prints what it was started with, then waits like a real session.
    const bin = join(home, 'bin')
    mkdirSync(bin)
    const agent = join(bin, 'fake-claude')
    writeFileSync(
      agent,
      '#!/bin/sh\n[ "$1" = --version ] && { echo "fake 1.0"; exit 0; }\n' +
        'echo "fake-agent-started $#"\nexec sleep 600\n'
    )
    chmodSync(agent, 0o755)
    const storage = join(home, 'Styr')
    mkdirSync(storage, { recursive: true })
    writeFileSync(
      join(storage, 'settings.json'),
      JSON.stringify({
        version: 1,
        claudeCommand: agent,
        shell: '/bin/bash',
        defaultRepoPath: home
      })
    )

    server = spawn(
      process.execPath,
      [join(buildDir, 'out', 'server', 'index.mjs'), 'serve', '--socket', socket],
      {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: home,
          STYR_HOME: join(home, '.styr'),
          // Never inherited: it would pin the server to one workspace.
          STYR_WORKSPACE_ID: 'from-a-parent-agent'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    server.stdout!.on('data', (chunk) => (serverLog += chunk))
    server.stderr!.on('data', (chunk) => (serverLog += chunk))
    await vi.waitFor(() => expect(serverLog).toContain('listening on'), WAIT)
  }, 60_000)

  afterAll(async () => {
    for (const each of clients) each.close()
    if (server && server.exitCode === null) {
      const exited = new Promise((resolve) => server.once('exit', resolve))
      server.kill('SIGTERM')
      await exited
    }
    rmSync(buildDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('listens on a socket only the user can open, and reports its version on attach', async () => {
    expect(statSync(socket).mode & 0o777).toBe(0o600)
    const a = await client()
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(a.hello()).toMatchObject({ protocol: 1, version, storageDir: join(home, 'Styr') })
    await expect(call(a, 'server:info')).resolves.toEqual(a.hello())
  })

  it('launches a task, and every client hears about it', async () => {
    const a = await client()
    const b = await client()
    const task = await call<Task>(a, 'tasks:create', { title: 'Launch me', orchestrate: false })
    const session = await call<TerminalSessionInfo>(a, 'terminal:launchAgent', task.id)
    expect(session).toMatchObject({ taskId: task.id, workspaceId: 'default' })

    const file = readFileSync(task.filePath, 'utf8')
    expect(file).toMatch(/^status: in_progress$/m)
    for (const each of [a, b]) {
      await vi.waitFor(
        () => expect(each.events.some(([method]) => method === 'tasks:changed')).toBe(true),
        WAIT
      )
    }

    // The agent runs in the server's PTY; attaching shows what it printed.
    const backlog = await call<TerminalOutput>(b, 'terminal:attach', session.id)
    await vi.waitFor(
      () => expect(backlog.data + b.output(session.id)).toContain('fake-agent-started'),
      WAIT
    )

    // Launching again adopts the running session instead of starting a second one.
    await expect(call(b, 'terminal:launchAgent', task.id)).resolves.toMatchObject({
      id: session.id
    })

    // Killing it marks the agent exited, with the server's own clock.
    const before = Date.now()
    await call(a, 'terminal:kill', session.id)
    await vi.waitFor(async () => {
      const agents = await call<{ taskId: string; state: string; at: string }[]>(a, 'agents:list')
      const agent = agents.find((each) => each.taskId === task.id)
      expect(agent?.state).toBe('exited')
      expect(Date.parse(agent!.at)).toBeGreaterThanOrEqual(before - 1000)
    }, WAIT)
  })

  it('takes the External sources switch from a client, and every client hears of it', async () => {
    const a = await client()
    const b = await client()
    await expect(call(a, 'sources:restTest', {})).rejects.toThrow(/Turn on External sources/)
    await call(a, 'server:experimental', { externalSources: true })
    await expect(call<Settings>(b, 'settings:get')).resolves.toMatchObject({
      experimental: { externalSources: true }
    })
    await vi.waitFor(
      () => expect(b.events.some(([method]) => method === 'settings:changed')).toBe(true),
      WAIT
    )
    await call(a, 'server:experimental', { externalSources: false })
  })

  it('reattaches a terminal with its backlog, and sizes it to the client that focused it last', async () => {
    const a = await client()
    const b = await client()
    const terminal = await call<TerminalSessionInfo>(a, 'terminal:create', { cwd: home })
    // `printf` with an argument, so the echoed command line never contains the marker itself.
    const print = (on: Client, marker: string): void =>
      on.peer.notify('terminal:write', [
        terminal.id,
        `printf '%s\\n' ${marker.split('').join(' ')} | tr -d '\\n'; echo\r`
      ])
    const size = (on: Client, tag: string): void =>
      on.peer.notify('terminal:write', [terminal.id, `stty size | sed 's/^/${tag}=/'\r`])

    await call(a, 'terminal:attach', terminal.id, 80, 24)
    print(a, 'marker1')
    await vi.waitFor(() => expect(a.output(terminal.id)).toContain('marker1'), WAIT)
    size(a, 'first')
    await vi.waitFor(() => expect(a.output(terminal.id)).toContain('first=24 80'), WAIT)

    // B attaches with a bigger window and focuses the terminal: the PTY follows B.
    await call(b, 'terminal:attach', terminal.id, 120, 40)
    b.peer.notify('terminal:focus', [terminal.id])
    size(b, 'second')
    await vi.waitFor(() => expect(b.output(terminal.id)).toContain('second=40 120'), WAIT)

    // A's window resizes meanwhile; B still has focus, so the PTY keeps B's size.
    a.peer.notify('terminal:resize', [terminal.id, 100, 30])
    size(b, 'third')
    await vi.waitFor(() => expect(b.output(terminal.id)).toContain('third=40 120'), WAIT)

    // A detaches: it stops receiving the terminal's output, while B types on.
    await call(a, 'terminal:detach', terminal.id)
    print(b, 'marker2')
    await vi.waitFor(() => expect(b.output(terminal.id)).toContain('marker2'), WAIT)
    expect(a.output(terminal.id)).not.toContain('marker2')

    // A goes away altogether (the laptop closed); the terminal lives on in the server.
    a.close()
    b.close()
    const c = await client()
    await expect(call<TerminalSessionInfo[]>(c, 'terminal:list')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: terminal.id })])
    )
    const backlog = await call<TerminalOutput>(c, 'terminal:attach', terminal.id, 90, 30)
    expect(backlog.data).toContain('marker1')
    expect(backlog.data).toContain('marker2')
    expect(backlog.sequence).toBeGreaterThan(0)

    // And the live stream continues after the backlog.
    print(c, 'marker3')
    await vi.waitFor(() => expect(c.output(terminal.id)).toContain('marker3'), WAIT)
    await call(c, 'terminal:kill', terminal.id)
  })

  it('runs an Auto-run pass on the server', async () => {
    const a = await client()
    const b = await client()
    const task = await call<Task>(a, 'tasks:create', {
      title: 'Pick me up',
      orchestrate: true,
      readiness: 'ready'
    })
    // Switching it on skips the startup grace, as the toggle does in the app.
    await expect(call(a, 'orchestrate:autoSet', true)).resolves.toMatchObject({ on: true })

    for (const each of [a, b]) {
      await vi.waitFor(
        () =>
          expect(
            each.events.some(
              ([method, [started]]) =>
                method === 'orchestrate:autoStarted' &&
                (started as TerminalSessionInfo).taskId === task.id
            )
          ).toBe(true),
        WAIT
      )
    }
    const sessions = await call<TerminalSessionInfo[]>(a, 'terminal:list')
    expect(sessions.some((session) => session.taskId === task.id)).toBe(true)
    // The flag persists on the server, in the workspace's own settings.
    const settings = JSON.parse(readFileSync(join(home, 'Styr', 'settings.json'), 'utf8'))
    expect(settings.autoDispatch).toBe(true)
    await call(a, 'orchestrate:autoSet', false)
  })

  it('removes its socket when it stops', async () => {
    const exited = new Promise<number | null>((resolve) => server.once('exit', resolve))
    server.kill('SIGTERM')
    await expect(exited).resolves.toBe(0)
    expect(() => statSync(socket)).toThrow()
  })
})
