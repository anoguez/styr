import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { build } from 'vite'
import type {
  Settings,
  Task,
  TerminalOutput,
  TerminalSessionInfo,
  WorkspaceInfo
} from '@core/types.js'
import { RpcPeer } from '../rpc/jsonRpc.js'
import { RemoteConnection, type TransportChild } from './connection.js'
import { createRemoteRouter } from './router.js'
import { TERMINAL_RESET } from './terminals.js'

/**
 * The client against a real `styr serve`: built from this checkout, run under plain Node on a
 * temporary socket and home. The transport runs `serve attach` directly instead of over ssh, so
 * everything past the ssh hop is real: the framing, the server's channels, the router's mapping,
 * a launch, a terminal attach, a drop while the terminal keeps printing, and the reattach with
 * its backlog. Gated like `serve.integration.test.ts`: it needs a node-pty that loads under Node.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
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

describe.skipIf(!enabled)(
  'remote client against styr serve (integration)',
  { timeout: 30_000 },
  () => {
    let home: string
    let socket: string
    let buildDir: string
    let server: ChildProcess
    let serverLog = ''
    const env = (): NodeJS.ProcessEnv => ({
      PATH: `${join(home, 'bin')}:/usr/bin:/bin`,
      HOME: home,
      STYR_HOME: join(home, '.styr')
    })

    /** `serve attach` as ssh would run it on the host, minus ssh. */
    function attachTransport(): TransportChild {
      const child = spawn(
        process.execPath,
        [join(buildDir, 'out', 'server', 'index.mjs'), 'serve', 'attach', '--socket', socket],
        { env: env(), stdio: ['pipe', 'pipe', 'pipe'] }
      )
      child.stdin.on('error', () => undefined)
      return {
        write: (data) => void (child.stdin.destroyed || child.stdin.write(data)),
        onStdout: (listener) => void child.stdout.on('data', listener),
        onStderr: (listener) => void child.stderr.on('data', listener),
        onExit: (listener) => {
          child.once('exit', (code) => listener(code))
          child.once('error', (error) => listener(null, error))
        },
        kill: () => void child.kill()
      }
    }

    const broadcasts: [string, unknown][] = []
    const active = 'remote-main'
    const workspaces: WorkspaceInfo[] = [
      { id: 'default', name: 'Default' },
      { id: 'remote-main', name: 'Remote', remote: { host: 'testhost', workspaceId: 'default' } }
    ]
    const router = createRemoteRouter({
      enabled: () => true,
      workspaces: () => workspaces,
      activeWorkspaceId: () => active,
      connect: (host, _link, events) =>
        new RemoteConnection(
          host,
          {
            spawn: attachTransport,
            setTimer: (run, ms) => setTimeout(run, ms),
            clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
            now: () => Date.now()
          },
          events
        ),
      broadcast: (channel, payload) => void broadcasts.push([channel, payload]),
      notify: () => undefined,
      updateTray: () => undefined,
      openExternal: () => undefined,
      isLocalSession: () => false,
      saveGlobalSettings: () => undefined,
      clientVersion: (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
        .version
    })
    const localSettings = (): Settings =>
      ({
        storageDir: '/local/Styr',
        activeWorkspaceId: active,
        shortcuts: {},
        updates: { checkAutomatically: true },
        experimental: { remoteWorkspaces: true }
      }) as unknown as Settings
    router.bindSettings(localSettings)
    const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
      Promise.resolve(
        router.invoke(channel, args, () =>
          channel === 'settings:get' ? localSettings() : `local ${channel}`
        )
      ) as Promise<T>
    const live = (): boolean => router.state().workspaces['remote-main']?.live === true
    const host = () => router.state().hosts[0]

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), 'styr-client-'))
      socket = join(home, 's.sock')
      buildDir = join(ROOT, 'out', `.client-test-${process.pid}`)
      await build({
        configFile: join(ROOT, 'vite.server.config.mts'),
        root: ROOT,
        logLevel: 'error',
        build: { outDir: join(buildDir, 'out', 'server') }
      })
      const bin = join(home, 'bin')
      mkdirSync(bin)
      const agent = join(bin, 'fake-claude')
      writeFileSync(
        agent,
        '#!/bin/sh\n[ "$1" = --version ] && { echo "fake 1.0"; exit 0; }\n' +
          'echo "fake-agent-started"\nexec sleep 600\n'
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
        { env: env(), stdio: ['ignore', 'pipe', 'pipe'] }
      )
      server.stdout!.on('data', (chunk) => (serverLog += chunk))
      server.stderr!.on('data', (chunk) => (serverLog += chunk))
      await vi.waitFor(() => expect(serverLog).toContain('listening on'), WAIT)
    }, 60_000)

    afterAll(async () => {
      router.stopAll()
      if (server && server.exitCode === null) {
        const exited = new Promise((resolve) => server.once('exit', resolve))
        server.kill('SIGTERM')
        await exited
      }
      rmSync(buildDir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    })

    it('connects, and serves the remote board through the router', async () => {
      router.refresh()
      await vi.waitFor(() => expect(live()).toBe(true), WAIT)
      expect(host()).toMatchObject({ host: 'testhost', status: 'connected' })
      const task = await call<Task>('tasks:create', { title: 'Remote task', orchestrate: false })
      const listed = await call<Task[]>('tasks:list', {})
      expect(listed.map((each) => each.id)).toContain(task.id)
      const settings = await call<Settings>('settings:get')
      // The workspace's own keys from the server, the app-level ones from here.
      expect(settings).toMatchObject({ shell: '/bin/bash', storageDir: '/local/Styr' })
    })

    it('launches on the server, attaches, and reattaches with what printed while away', async () => {
      const [task] = await call<Task[]>('tasks:list', {})
      const session = await call<TerminalSessionInfo>('terminal:launchAgent', task!.id)
      expect(session).toMatchObject({ host: 'testhost', workspaceId: 'remote-main' })
      const output = (): string =>
        broadcasts
          .filter(
            ([channel, payload]) =>
              channel === 'terminal:data' && (payload as { id: string }).id === session.id
          )
          .map(([, payload]) => (payload as TerminalOutput).data)
          .join('')
      const backlog = await call<TerminalOutput>('terminal:backlog', session.id)
      await vi.waitFor(() => expect(backlog.data + output()).toContain('fake-agent-started'), WAIT)

      // The laptop sleeps: the link drops, the board turns read-only and nothing is queued.
      router.suspend()
      expect(host()?.status).toBe('offline')
      await expect(call('tasks:create', { title: 'Queued?' })).rejects.toThrow(/queued/)
      expect((await call<Task[]>('tasks:list', {})).length).toBe(1)

      // Meanwhile the terminal keeps going on the server (another client types; the PTY echoes).
      const other = connect(socket)
      await new Promise((resolve) => other.once('connect', resolve))
      const peer = new RpcPeer((line) => other.write(line))
      other.on('data', (chunk) => peer.receive(chunk))
      peer.notify('terminal:write', [session.id, 'typed-while-away'])
      await new Promise((resolve) => setTimeout(resolve, 300))
      other.destroy()

      broadcasts.length = 0
      router.wake()
      await vi.waitFor(() => expect(live()).toBe(true), WAIT)
      await vi.waitFor(() => {
        const replay = broadcasts.find(
          ([channel, payload]) =>
            channel === 'terminal:data' &&
            (payload as TerminalOutput).data.startsWith(TERMINAL_RESET)
        )
        expect((replay?.[1] as TerminalOutput | undefined)?.data).toContain('typed-while-away')
      }, WAIT)
      expect(router.mirrorBacklog(session.id)?.data).toContain('typed-while-away')
      // Nothing refused while away reached the server.
      expect((await call<Task[]>('tasks:list', {})).map((each) => each.title)).toEqual([
        'Remote task'
      ])
    })
  }
)
