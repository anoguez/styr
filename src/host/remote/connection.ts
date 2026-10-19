import { reconnectDelay } from '@core/remote.js'
import { isHostKeyProblem } from '@core/remoteSetup.js'
import { remoteServerHelloSchema } from '@core/taskSchema.js'
import type { RemoteConnectionStatus, RemoteHostState } from '@core/types.js'
import { PROTOCOL_VERSION, RPC_ERRORS, RpcError, RpcPeer } from '../rpc/jsonRpc.js'

/**
 * One host's connection to its `styr serve` (`docs/architecture/remote.md`): a single `ssh … serve
 * attach` child, shared by every workspace on that host, speaking newline-delimited JSON-RPC over
 * its stdio. Electron-free: the child and the clock are ports, so the state machine is tested
 * with a fake transport.
 *
 * connecting ──hello──▶ connected ──child exits──▶ reconnecting ──timer / retry / wake──▶ connecting
 *      │                    │                                                    ▲
 *      └──child exits───────┼──────────────────────────────────▶ reconnecting ───┘
 *                     suspend / stop ──▶ offline ──wake / start──▶ connecting
 *
 * A server that says hello in another protocol leaves the connection `incompatible`: the link
 * stays up (so nothing retries in a loop), but no request or notification passes until the server
 * is upgraded and Retry reconnects.
 *
 * The backoff (1s → 30s) arms one timer for a known instant and stops once connected: there is no
 * polling interval. Nothing is queued while disconnected; a request then rejects at once.
 */

/** The `ssh` child, as the connection needs it. */
export interface TransportChild {
  write(data: string): void
  onStdout(listener: (chunk: Buffer | string) => void): void
  onStderr(listener: (chunk: Buffer | string) => void): void
  /** The child is gone, or never started (`error` is then set, e.g. ssh not on PATH). */
  onExit(listener: (code: number | null, error?: Error) => void): void
  kill(): void
}

export interface ConnectionPorts {
  /** Starts the `ssh` child for this host. */
  spawn(): TransportChild
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  now(): number
}

/** What the server says on attach (`server:hello`): see `ServerInfo` in `src/server/hub.ts`. */
export interface ServerHello {
  protocol: number
  version: string
  pid: number
  startedAt: string
  storageDir: string
  platform: string
}

export interface ConnectionEvents {
  /** The state changed (status, error, retry time or server version). */
  state(state: RemoteHostState): void
  /** The server said hello: requests may be sent. `reconnect` is false for the first time. */
  connected(hello: ServerHello, reconnect: boolean): void
  /** A connected link went away (child exit, suspend or stop). */
  disconnected(): void
  /** A notification from the server: a broadcast, terminal data, the tray model. */
  notification(method: string, params: unknown[]): void
}

/**
 * How long a started `ssh` may take to bring the server's hello. ssh's own `ConnectTimeout` covers
 * an unreachable host; this covers a link that connects but whose `serve attach` never answers (a
 * hung server, a remote shell that blocks). One timer for a known instant, not a poll.
 */
export const HELLO_TIMEOUT_MS = 15_000

/** The last bytes of ssh's stderr kept for the error shown: its own words, not a guess. */
const STDERR_LIMIT = 2_000

export class RemoteConnection {
  private status: RemoteConnectionStatus = 'offline'
  private lastError: string | undefined
  private retryAt: number | undefined
  private hello: ServerHello | undefined
  private child: TransportChild | undefined
  private peer: RpcPeer | undefined
  private timer: unknown
  private helloTimer: unknown
  private failures = 0
  private everConnected = false
  /** False once stopped: nothing reconnects until `start`. */
  private wanted = false
  /** True while the machine sleeps or the network is down: wait for `wake`, do not back off. */
  private suspended = false

  constructor(
    readonly host: string,
    private readonly ports: ConnectionPorts,
    private readonly events: ConnectionEvents
  ) {}

  state(): RemoteHostState {
    return {
      host: this.host,
      status: this.status,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.retryAt !== undefined ? { retryAt: this.retryAt } : {}),
      ...(this.hello?.version ? { serverVersion: this.hello.version } : {}),
      ...(this.hello?.startedAt ? { serverStartedAt: this.hello.startedAt } : {})
    }
  }

  /** What the server said on its last hello, connected or incompatible. */
  get server(): ServerHello | undefined {
    return this.hello
  }

  get connected(): boolean {
    return this.status === 'connected'
  }

  /** Begins connecting, unless already connected or on the way. */
  start(): void {
    this.wanted = true
    if (this.status === 'offline' && !this.suspended) this.attempt()
  }

  /** Disconnects for good (the flag went off, the host's last workspace was removed). */
  stop(): void {
    this.wanted = false
    this.clearTimer()
    this.drop()
    this.lastError = undefined
    this.setStatus('offline')
  }

  /** "Retry now": skips the wait. Does nothing while connected or already connecting. */
  retryNow(): void {
    if (!this.wanted || this.status === 'connected' || this.status === 'connecting') return
    this.suspended = false
    this.failures = 0
    this.clearTimer()
    // An incompatible server's link is still open: replace it, the server may be upgraded now.
    this.drop()
    this.attempt()
  }

  /**
   * The machine woke or the network came back. After a sleep the old link may be dead without
   * ssh knowing yet (`fresh`), so it is replaced rather than trusted; otherwise only a link that
   * is down is retried, at once and with the backoff reset.
   */
  wake(fresh: boolean): void {
    this.suspended = false
    if (!this.wanted) return
    if (this.status === 'connected' && !fresh) return
    if ((this.status === 'connecting' || this.status === 'incompatible') && !fresh) return
    this.failures = 0
    this.clearTimer()
    this.drop()
    this.attempt()
  }

  /** The machine is going to sleep: drop the link and wait for `wake` instead of backing off. */
  suspend(reason: string): void {
    if (!this.wanted) return
    this.suspended = true
    this.clearTimer()
    this.drop()
    this.lastError = reason
    this.setStatus('offline')
  }

  request(method: string, params: unknown[] = []): Promise<unknown> {
    if (!this.peer || this.status !== 'connected') {
      return Promise.reject(
        new RpcError(RPC_ERRORS.INTERNAL, `Not connected to ${this.host}. Nothing was queued.`)
      )
    }
    return this.peer.request(method, params)
  }

  /** A one-way message; dropped while disconnected, never queued. */
  notify(method: string, params: unknown[] = []): void {
    if (this.peer && this.status === 'connected') this.peer.notify(method, params)
  }

  private attempt(): void {
    this.retryAt = undefined
    this.setStatus('connecting')
    let stderr = ''
    let child: TransportChild
    try {
      child = this.ports.spawn()
    } catch (error) {
      this.failed(error instanceof Error ? error.message : String(error))
      return
    }
    this.child = child
    this.helloTimer = this.ports.setTimer(() => {
      this.helloTimer = undefined
      if (this.child !== child || this.status !== 'connecting') return
      this.child = undefined
      this.peer?.close(`The connection to ${this.host} closed.`)
      this.peer = undefined
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      const said = exitReason(stderr, null, undefined, this.host)
      this.failed(
        `${this.host} did not answer within ${HELLO_TIMEOUT_MS / 1000}s${said === 'ssh was stopped.' ? '.' : `: ${said}`}`
      )
    }, HELLO_TIMEOUT_MS)
    const peer = new RpcPeer(
      (line) => {
        try {
          child.write(line)
        } catch {
          // The child's stdin is closing; its exit arrives next.
        }
      },
      { notification: (method, params) => this.received(child, method, params) }
    )
    this.peer = peer
    child.onStdout((chunk) => {
      if (this.child === child) peer.receive(chunk)
    })
    child.onStderr((chunk) => {
      stderr = (stderr + String(chunk)).slice(-STDERR_LIMIT)
    })
    child.onExit((code, error) => {
      if (this.child !== child) return
      this.clearHelloTimer()
      this.child = undefined
      this.peer = undefined
      peer.close(`The connection to ${this.host} closed.`)
      const wasConnected = this.status === 'connected'
      this.failed(exitReason(stderr, code, error, this.host))
      if (wasConnected) this.events.disconnected()
    })
  }

  private received(child: TransportChild, method: string, params: unknown[]): void {
    if (this.child !== child) return
    if (method === 'server:hello') {
      this.clearHelloTimer()
      // Checked like every answer (`validation.ts`): it names the version and the pid to stop.
      const parsed = remoteServerHelloSchema.safeParse(params[0])
      const hello = parsed.success ? parsed.data : undefined
      this.hello = hello
      this.failures = 0
      if (hello?.protocol !== PROTOCOL_VERSION) {
        this.lastError = incompatibleMessage(this.host, hello)
        this.setStatus('incompatible')
        return
      }
      const reconnect = this.everConnected
      this.everConnected = true
      this.lastError = undefined
      this.setStatus('connected')
      this.events.connected(hello, reconnect)
      return
    }
    if (this.status === 'connected') this.events.notification(method, params)
  }

  /** An attempt or a link failed: back off, unless stopped or asleep. */
  private failed(reason: string): void {
    this.lastError = reason
    if (!this.wanted || this.suspended) {
      this.setStatus('offline')
      return
    }
    const delay = reconnectDelay(this.failures)
    this.failures += 1
    this.retryAt = this.ports.now() + delay
    this.timer = this.ports.setTimer(() => {
      this.timer = undefined
      if (this.wanted && !this.suspended && this.status === 'reconnecting') this.attempt()
    }, delay)
    this.setStatus('reconnecting')
  }

  private clearHelloTimer(): void {
    if (this.helloTimer !== undefined) this.ports.clearTimer(this.helloTimer)
    this.helloTimer = undefined
  }

  /** Ends the current child without treating its exit as a failure. */
  private drop(): void {
    this.clearHelloTimer()
    const child = this.child
    const peer = this.peer
    const wasConnected = this.status === 'connected'
    this.child = undefined
    this.peer = undefined
    peer?.close(`The connection to ${this.host} closed.`)
    try {
      child?.kill()
    } catch {
      // Already gone.
    }
    if (wasConnected) this.events.disconnected()
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.ports.clearTimer(this.timer)
    this.timer = undefined
    this.retryAt = undefined
  }

  private setStatus(status: RemoteConnectionStatus): void {
    this.status = status
    if (status !== 'reconnecting') this.retryAt = undefined
    this.events.state(this.state())
  }
}

/** Why an `incompatible` server is not used, and what fixes it. */
export function incompatibleMessage(host: string, hello: ServerHello | undefined): string {
  const version = hello?.version ? `Styr ${hello.version}` : 'an unknown Styr'
  return (
    `${host} runs ${version}, whose server protocol (${String(hello?.protocol ?? '?')}) is not ` +
    `this app's (${PROTOCOL_VERSION}). Nothing is sent to it until the server is upgraded.`
  )
}

/** ssh's last stderr line when it said something, else how the child ended. */
export function exitReason(
  stderr: string,
  code: number | null,
  error?: Error,
  host = '<host>'
): string {
  if (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'ssh was not found on PATH.'
      : error.message
  }
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const last = lines.at(-1)
  // Only the user may accept a host key: say how, after ssh's own words.
  if (last && isHostKeyProblem(stderr)) {
    return `${last} Run “ssh ${host}” once in a terminal to check and accept the key, then click Retry.`
  }
  if (last) return last
  return code === null ? 'ssh was stopped.' : `ssh exited with code ${code}.`
}
