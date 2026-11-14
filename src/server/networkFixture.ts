import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { createAccessStore, type AccessStore } from '@host/remoteAccess/accessStore.js'
import { createNetworkPolicy, type GatePorts } from '@host/remoteAccess/gate.js'
import { createSecureClientHandshake } from '@host/remoteAccess/secureClient.js'
import type { SecureFrameChannel } from '@host/remoteAccess/secureSession.js'
import { RpcPeer } from '@host/rpc/jsonRpc.js'
import { createHub, PROTOCOL_VERSION, type Hub, type HubPorts } from './hub.js'
import { MAX_FRAME_BYTES, startNetworkListener, type NetworkListener } from './wsListener.js'

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
    currentGlobal: () => state.global,
    sourcesOf: () => []
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
    policy: () => createNetworkPolicy(gatePorts),
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
      log: (message) => host.state.log.push(message),
      now: () => host.state.clock,
      pingMs: extra.pingMs,
      handshakeMs: extra.handshakeMs,
      limitLoopback: true
    },
    '127.0.0.1',
    0
  )
}

export interface Credentials {
  deviceId: string
  /** The device's Ed25519 private key (PKCS8 DER, base64): it never leaves the phone. */
  privateKey: string
}

/** The phone's side of protocol 2, as the protocol document describes it. */
export class TestPhone {
  socket!: WebSocket
  readonly messages: string[] = []
  private waiting: ((text: string) => void)[] = []
  closed?: { code: number; reason: string }
  /** The session once signed in: every later frame goes through it. */
  channel?: SecureFrameChannel

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

  /** The next frame; '' once the socket has closed. */
  next(): Promise<string> {
    const queued = this.messages.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.closed) return Promise.resolve('')
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  async waitClosed(): Promise<{ code: number; reason: string }> {
    while (!this.closed) await new Promise((resolve) => setTimeout(resolve, 5))
    return this.closed
  }

  send(value: unknown): void {
    this.socket.send(typeof value === 'string' ? value : JSON.stringify(value))
  }

  /**
   * Runs the handshake; the device id the host gave (pairing) or true (sign-in), or undefined when
   * the host refused, hung up or is not the pinned one (then this side hangs up, sending nothing).
   */
  private async handshake(
    privateKey: ReturnType<typeof createPrivateKey>,
    signIn: { type: 'auth'; deviceId: string } | { type: 'pair'; name: string; secret: string }
  ): Promise<{ deviceId?: string } | undefined> {
    const client = createSecureClientHandshake({
      pinnedFingerprint: this.fingerprint,
      identity: {
        privateKey,
        publicKey: createPublicKey(privateKey)
          .export({ type: 'spki', format: 'der' })
          .toString('base64')
      },
      signIn,
      maxMessageBytes: MAX_FRAME_BYTES
    })
    this.send(client.start())
    try {
      for (;;) {
        const frame = await this.next()
        if (frame === '') return undefined
        const step = client.receive(frame)
        if (step.kind === 'send') for (const out of step.frames) this.send(out)
        if (step.kind === 'ready') {
          this.channel = step.channel
          return { deviceId: step.deviceId }
        }
      }
    } catch {
      this.socket.close()
      return undefined
    }
  }

  async authenticate(credentials: Credentials): Promise<boolean> {
    const key = createPrivateKey({
      key: Buffer.from(credentials.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8'
    })
    return (
      (await this.handshake(key, { type: 'auth', deviceId: credentials.deviceId })) !== undefined
    )
  }

  async pair(secret: string, name: string): Promise<Credentials | undefined> {
    const pair = generateKeyPairSync('ed25519')
    const result = await this.handshake(pair.privateKey, { type: 'pair', name, secret })
    if (!result?.deviceId) return undefined
    return {
      deviceId: result.deviceId,
      privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    }
  }

  /** After `ready`: a JSON-RPC peer over the sealed session, and everything pushed to it. */
  rpc(): { peer: RpcPeer; pushed: [string, unknown[]][] } {
    const channel = this.channel!
    const pushed: [string, unknown[]][] = []
    const peer = new RpcPeer(
      (line) => {
        for (const frame of channel.seal(line.replace(/\n$/, ''))) this.socket.send(frame)
      },
      { notification: (method, params) => pushed.push([method, params]) }
    )
    const deliver = (frame: string): void => {
      const text = channel.open(frame)
      if (text !== undefined) peer.receive(`${text}\n`)
    }
    this.socket.removeAllListeners('message')
    this.socket.on('message', (data) => deliver(data.toString()))
    // Frames that came in before this, in order: skipping one would break the channel.
    for (const queued of this.messages.splice(0)) deliver(queued)
    return { peer, pushed }
  }

  close(): void {
    this.socket.terminate()
  }
}
