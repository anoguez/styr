import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { createAccessStore, type AccessStore } from '@host/remoteAccess/accessStore.js'
import { createNetworkPolicy, type GatePorts } from '@host/remoteAccess/gate.js'
import {
  authProof,
  pairProof,
  serverChallengeValid,
  verifierOf
} from '@host/remoteAccess/handshake.js'
import { RpcPeer } from '@host/rpc/jsonRpc.js'
import { createHub, PROTOCOL_VERSION, type Hub, type HubPorts } from './hub.js'
import { startNetworkListener, type NetworkListener } from './wsListener.js'

/** A fake host for the network tests: workspaces `open` and `closed`, with `open` flagged. */
export function networkHost() {
  const dir = mkdtempSync(join(tmpdir(), 'styr-net-'))
  const storePath = join(dir, 'remote-access.json')
  const state = {
    shared: new Set(['open']),
    active: 'open',
    sessions: new Map<string, string | undefined>([
      ['t-open', 'open'],
      ['t-closed', 'closed']
    ]),
    global: { storageDir: '/Styr', activeWorkspaceId: 'open' } as unknown,
    clock: 1_000_000,
    log: [] as string[],
    calls: [] as string[]
  }
  const gatePorts: GatePorts = {
    isOpen: (id) => state.shared.has(id),
    activeId: () => state.active,
    sessionWorkspace: (id) => ({
      exists: state.sessions.has(id),
      workspaceId: state.sessions.get(id)
    }),
    currentGlobal: () => state.global
  }
  const hubPorts: HubPorts = {
    invoke: {
      'workspaces:list': {
        args: z.tuple([]),
        run: () => ({
          activeId: state.active,
          workspaces: ['open', 'closed'].map((id) => ({
            id,
            name: id,
            taskCount: 1,
            liveSessions: 0
          }))
        })
      },
      'tasks:list': { args: z.tuple([]), run: () => [{ id: `TASK-1@${state.active}` }] },
      'terminal:list': {
        args: z.tuple([]),
        run: () => [...state.sessions].map(([id, workspaceId]) => ({ id, workspaceId }))
      },
      'terminal:kill': {
        args: z.tuple([z.string()]),
        run: ((id: string) => state.calls.push(`kill ${id}`)) as never
      },
      'settings:save': {
        args: z.tuple([z.unknown()]),
        run: ((change: unknown) => state.calls.push(`save ${JSON.stringify(change)}`)) as never
      },
      'server:experimentalProbe': { args: z.tuple([]), run: () => 'x' }
    },
    send: {
      'terminal:write': {
        args: z.tuple([z.string(), z.string()]),
        run: ((id: string, data: string) => state.calls.push(`write ${id} ${data}`)) as never
      }
    },
    info: () => ({
      protocol: PROTOCOL_VERSION,
      version: '1.0.0',
      pid: 1,
      startedAt: '',
      storageDir: '/Styr',
      platform: 'test'
    }),
    tray: () => ({
      statuses: [
        { taskId: 'TASK-1', workspaceId: 'open' },
        { taskId: 'TASK-2', workspaceId: 'closed' }
      ],
      titles: { 'open:TASK-1': 'Shared', 'closed:TASK-2': 'Secret' }
    }),
    experimental: () => state.calls.push('experimental'),
    terminals: {
      backlog: (id) => ({ data: `backlog ${id}`, sequence: 1, marks: [] }),
      resize: () => {}
    },
    pin: { current: () => undefined, clear: () => {} }
  }
  const hub = createHub(hubPorts)
  const store = () => createAccessStore({ path: storePath, now: () => state.clock })
  return {
    dir,
    state,
    hub,
    storePath,
    store,
    policy: createNetworkPolicy(gatePorts),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

export async function listenOnLoopback(
  host: ReturnType<typeof networkHost>,
  store: AccessStore,
  extra: { hub?: Hub; pingMs?: number; handshakeMs?: number } = {}
): Promise<NetworkListener> {
  return startNetworkListener(
    {
      hub: extra.hub ?? host.hub,
      store,
      policy: host.policy,
      protocol: PROTOCOL_VERSION,
      log: (message) => host.state.log.push(message),
      now: () => host.state.clock,
      pingMs: extra.pingMs,
      handshakeMs: extra.handshakeMs
    },
    '127.0.0.1',
    0
  )
}

export interface Credentials {
  deviceId: string
  /** The 32-byte token, hex: it never leaves the phone. */
  token: string
}

/** The phone's side of the handshake, as the protocol document describes it. */
export class TestPhone {
  socket!: WebSocket
  readonly messages: string[] = []
  private waiting: ((text: string) => void)[] = []
  closed?: { code: number; reason: string }
  private clientNonce = randomBytes(16).toString('hex')
  serverNonce = ''

  constructor(
    port: number,
    readonly fingerprint: string,
    options: { headers?: Record<string, string> } = {}
  ) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: options.headers })
    this.socket.on('message', (data) => {
      const text = data.toString()
      const waiter = this.waiting.shift()
      if (waiter) waiter(text)
      else this.messages.push(text)
    })
    this.socket.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() }
      for (const waiter of this.waiting.splice(0)) waiter('')
    })
    this.socket.on('error', () => undefined)
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve())
      this.socket.once('error', reject)
      this.socket.once('unexpected-response', (_request, response) =>
        reject(new Error(`HTTP ${response.statusCode}`))
      )
    })
  }

  next(): Promise<string> {
    const queued = this.messages.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  async waitClosed(): Promise<{ code: number; reason: string }> {
    while (!this.closed) await new Promise((resolve) => setTimeout(resolve, 5))
    return this.closed
  }

  send(value: unknown): void {
    this.socket.send(typeof value === 'string' ? value : JSON.stringify(value))
  }

  /** hello → challenge, checking the server against the pinned fingerprint. */
  async hello(): Promise<{ ok: boolean }> {
    this.send({ type: 'hello', protocol: PROTOCOL_VERSION, clientNonce: this.clientNonce })
    const challenge = JSON.parse(await this.next()) as {
      serverNonce: string
      serverKey: string
      signature: string
    }
    this.serverNonce = challenge.serverNonce
    return { ok: serverChallengeValid(challenge, this.clientNonce, this.fingerprint) }
  }

  async authenticate(credentials: Credentials): Promise<boolean> {
    const hello = await this.hello()
    if (!hello.ok) return false
    this.send({
      type: 'auth',
      deviceId: credentials.deviceId,
      proof: authProof(
        verifierOf(Buffer.from(credentials.token, 'hex')),
        credentials.deviceId,
        this.serverNonce,
        this.clientNonce,
        this.fingerprint
      )
    })
    return JSON.parse(await this.next()).type === 'ready'
  }

  async pair(secret: string, name: string): Promise<Credentials | undefined> {
    const hello = await this.hello()
    if (!hello.ok) return undefined
    const token = randomBytes(32)
    const verifier = verifierOf(token)
    this.send({
      type: 'pair',
      name,
      verifier,
      proof: pairProof(secret, this.serverNonce, this.clientNonce, this.fingerprint, name, verifier)
    })
    const paired = JSON.parse(await this.next()) as { type: string; deviceId?: string }
    if (paired.type !== 'paired') return undefined
    expectReady(JSON.parse(await this.next()))
    return { deviceId: paired.deviceId!, token: token.toString('hex') }
  }

  /** After `ready`: a JSON-RPC peer over the socket, and everything pushed to it. */
  rpc(): { peer: RpcPeer; pushed: [string, unknown[]][] } {
    const pushed: [string, unknown[]][] = []
    const peer = new RpcPeer((line) => this.socket.send(line.replace(/\n$/, '')), {
      notification: (method, params) => pushed.push([method, params])
    })
    this.socket.removeAllListeners('message')
    this.socket.on('message', (data) => peer.receive(`${data.toString()}\n`))
    for (const queued of this.messages.splice(0)) peer.receive(`${queued}\n`)
    return { peer, pushed }
  }

  close(): void {
    this.socket.terminate()
  }
}

function expectReady(message: { type: string }): void {
  if (message.type !== 'ready') throw new Error(`expected ready, got ${message.type}`)
}
