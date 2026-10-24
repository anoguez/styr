import { shippedSettings } from '@core/config.js'
import type { Settings, Task } from '@core/types.js'
import { RpcPeer } from '../rpc/jsonRpc.js'
import type { ConnectionPorts, ServerHello, TransportChild } from './connection.js'

/**
 * Test doubles for remote workspaces: an `ssh` child that is really an in-memory pipe to a fake
 * server speaking the same newline-delimited JSON-RPC, and a clock whose timers run when a test
 * says so. Nothing here spawns a process or waits on real time.
 */

export const HELLO: ServerHello = {
  protocol: 1,
  version: '9.9.9',
  pid: 42,
  startedAt: '2026-10-19T00:00:00.000Z',
  storageDir: '/home/me/Styr',
  platform: 'linux x64'
}

/** A whole task as a server sends it, from the few fields a test cares about. */
export function remoteTask(fields: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    status: 'backlog',
    priority: 'medium',
    readiness: 'ready',
    description: '',
    activity: [],
    tags: [],
    orchestrate: true,
    useWorktree: false,
    extraRepos: [],
    questions: [],
    blockedBy: [],
    contextFiles: [],
    sessions: [],
    order: 0,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    filePath: `/home/me/Styr/tasks/${fields.id}.md`,
    format: 'markdown',
    ...fields
  }
}

/** A server's whole settings, as `loadSettings` answers, with a test's own values laid over. */
export function remoteSettings(fields: Partial<Settings> = {}): Settings {
  return { ...shippedSettings(), storageDir: '/home/me/Styr', shell: '/bin/bash', ...fields }
}

export interface FakeChild extends TransportChild {
  /** Lines the client wrote. */
  written: string[]
  killed: boolean
  stdout(text: string): void
  stderr(text: string): void
  exit(code: number | null, error?: Error): void
}

export function fakeChild(): FakeChild {
  const out: ((chunk: string) => void)[] = []
  const err: ((chunk: string) => void)[] = []
  const exits: ((code: number | null, error?: Error) => void)[] = []
  let ended = false
  const child: FakeChild = {
    written: [],
    killed: false,
    write: (data) => void child.written.push(data),
    onStdout: (listener) => void out.push(listener as (chunk: string) => void),
    onStderr: (listener) => void err.push(listener as (chunk: string) => void),
    onExit: (listener) => void exits.push(listener),
    kill: () => {
      child.killed = true
      child.exit(null)
    },
    stdout: (text) => out.forEach((listener) => listener(text)),
    stderr: (text) => err.forEach((listener) => listener(text)),
    exit: (code, error) => {
      if (ended) return
      ended = true
      exits.forEach((listener) => listener(code, error))
    }
  }
  return child
}

/** Timers that fire only from `advance`, and a clock that moves with them. */
export function fakeClock() {
  let now = 1_000_000
  let nextId = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  const ports: Pick<ConnectionPorts, 'setTimer' | 'clearTimer' | 'now'> = {
    setTimer: (run, ms) => {
      const id = nextId++
      timers.set(id, { at: now + ms, run })
      return id
    },
    clearTimer: (handle) => void timers.delete(handle as number),
    now: () => now
  }
  return {
    ports,
    pending: () => [...timers.values()].map((timer) => timer.at - now).sort((a, b) => a - b),
    advance(ms: number): void {
      now += ms
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.run()
      }
    }
  }
}

export type ServerHandler = (params: unknown[]) => unknown

/**
 * A fake `styr serve` behind each spawned child: answers requests from `handlers`, records every
 * call, and pushes notifications to the client. `connect()` starts the session with a hello.
 */
export function fakeServer(handlers: Record<string, ServerHandler> = {}) {
  const calls: [string, unknown[]][] = []
  const notifications: [string, unknown[]][] = []
  const children: FakeChild[] = []
  let peer: RpcPeer | undefined
  let current: FakeChild | undefined

  function spawn(): FakeChild {
    const child = fakeChild()
    children.push(child)
    current = child
    const server = new RpcPeer((line) => child.stdout(line), {
      request: (method, params) => {
        calls.push([method, params])
        const handler = handlers[method]
        if (!handler) throw new Error(`Unknown method: ${method}`)
        return handler(params.map((param) => (param === null ? undefined : param)))
      },
      notification: (method, params) => void notifications.push([method, params])
    })
    peer = server
    const write = child.write
    child.write = (data) => {
      write(data)
      server.receive(data)
    }
    child.onExit(() => {
      if (peer === server) peer = undefined
      server.close()
    })
    return child
  }

  return {
    handlers,
    calls,
    notifications,
    children,
    spawn,
    /** The server says hello on the newest child. */
    hello: (hello: ServerHello = HELLO) => peer?.notify('server:hello', [hello]),
    push: (method: string, ...params: unknown[]) => peer?.notify(method, params),
    /** The ssh child dies, with ssh's last words on stderr. */
    drop: (stderr = '', code: number | null = 255) => {
      if (stderr) current?.stderr(stderr)
      current?.exit(code)
    },
    methods: () => calls.map(([method]) => method)
  }
}

/** Lets queued promise callbacks and replies run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}
