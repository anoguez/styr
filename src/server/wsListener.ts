import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import type { ApprovalPort, ApprovalQuestion } from '@host/remoteAccess/accessService.js'
import type { AccessStore, PairingOffer } from '@host/remoteAccess/accessStore.js'
import {
  addressKind,
  admitConnection,
  normalizeAddress,
  proxyHeader
} from '@host/remoteAccess/addresses.js'
import type { ClientPolicy } from '@host/remoteAccess/gate.js'
import { HANDSHAKE_MAX_BYTES, HANDSHAKE_TIMEOUT_MS } from '@host/remoteAccess/handshake.js'
import { createFailureLimiter } from '@host/remoteAccess/rateLimit.js'
import {
  SECURE_FRAME_MAX_CHARS,
  createSecureServerHandshake,
  type SecureFrameChannel
} from '@host/remoteAccess/secureSession.js'
import type { Hub } from './hub.js'

/** The largest message a signed-in client may send. Terminal input and task drafts are far below. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024
/** As on the Unix socket: a client this far behind is dropped rather than buffered. */
export const MAX_BUFFERED_BYTES = 32 * 1024 * 1024
const MAX_HANDSHAKING = 16
/** How long a device that asked to pair waits for the person at the host to answer. */
export const APPROVAL_TIMEOUT_MS = 60_000
const MAX_PER_ADDRESS = 8
/**
 * Handshakes one address may have in flight: well under `MAX_HANDSHAKING`, so one peer cannot hold
 * every slot and turn the real devices away.
 */
const MAX_HANDSHAKING_PER_ADDRESS = 4
const MAX_HANDSHAKING_PER_LOOPBACK = 8
/**
 * The same for a whole IPv6 /64 (`limitKey`), larger than one address's: every IPv6 device on a
 * network shares its /64, so one peer must not lock the others out, but rotating addresses inside
 * it must not buy more than this either.
 */
const MAX_HANDSHAKING_PER_NET = 8
/** Failures one IPv6 /64 may have in a minute, across its addresses (one address: 5). */
const MAX_FAILURES_PER_NET = 30
/** Connections one IPv6 /64 may hold, across its addresses (one address: `MAX_PER_ADDRESS`). */
const MAX_PER_NET = 32
/** Every device behind an ssh tunnel is 127.0.0.1, so loopback gets a larger share. */
const MAX_PER_LOOPBACK = 32

/** WebSocket close codes the listener uses (4000–4999 are for applications). */
export const CLOSE = {
  BAD_REQUEST: 4400,
  UNAUTHORIZED: 4401,
  REVOKED: 4403,
  TIMEOUT: 4408,
  BUSY: 4429
} as const

export type { ApprovalPort, ApprovalQuestion }

export interface NetworkListenerOptions {
  hub: Hub
  store: AccessStore
  /** One per connection: it remembers what that device opened. */
  policy: () => ClientPolicy
  log(message: string): void
  now?(): number
  /** Liveness pings, in ms; a phone that left the network is dropped after one missed. */
  pingMs?: number
  handshakeMs?: number
  /** Told how many devices are connected, each time it changes. */
  onConnections?(count: number): void
  /** Count failures from loopback too (tests); a tunnel shares one address, so it is off. */
  limitLoopback?: boolean
  /**
   * Whether a socket from `remote` that arrived on this computer's `local` address may be read:
   * undefined if so, else why not. `admitConnection` (same network only) unless a test swaps it.
   */
  admit?(local: string, remote: string): string | undefined
  /** Where to listen; every interface (dual-stack) unless a test pins loopback. */
  host?: string
  /** Answers requests to pair by approval. Absent (`styr serve`): every request is refused. */
  approvals?: ApprovalPort
  /** Tests: how long a request waits for its answer. */
  approvalMs?: number
}

export interface NetworkListener {
  address: { address: string; port: number }
  /** Connections open right now. */
  connections(): number
  /** The devices with at least one of them. */
  connectedDevices(): string[]
  /** Ends every connection of a device. */
  disconnectDevice(deviceId: string, code?: number): void
  close(): Promise<void>
}

/**
 * Tunnelled devices share one source address, and a local process could lock them all out with
 * failed handshakes. Failures from loopback are logged but not counted: sign-in is a signature,
 * not a password, so there is nothing to guess.
 */
const isLoopback = (source: string): boolean => addressKind(source) === 'loopback'

/** One signed-in connection, as the device registry holds it. */
interface Session {
  /** Stops listening to the peer at once, then closes (and, if it will not, cuts) the socket. */
  end(code: number, reason: string): void
}

/** The source address of a request, as the socket saw it (an IPv4 peer as IPv4). */
const sourceOf = (socket: Socket): string => normalizeAddress(socket.remoteAddress ?? '')
/** The address of this computer the request arrived on. */
const targetOf = (socket: Socket): string => normalizeAddress(socket.localAddress ?? '')

/**
 * What the limits count by: an IPv4 address, or an IPv6 address's /64. One machine on a network
 * may hold a whole /64 (privacy addresses), so counting IPv6 addresses one by one would let it slip
 * every per-address limit.
 */
export function limitKey(source: string): string {
  if (!source.includes(':')) return source
  const groups = source.split('::')
  const head = (groups[0] ?? '').split(':').filter(Boolean)
  const tail = groups.length > 1 ? (groups[1] ?? '').split(':').filter(Boolean) : []
  const full = [
    ...head,
    ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'),
    ...tail
  ]
  return `${full
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`
}

/** The admission rule a socket is held to: see `admitConnection`. */
export type Admit = (local: string, remote: string) => string | undefined

/**
 * Listens for devices on this computer's networks. Nothing reaches the hub before the handshake
 * (`secureSession.ts`) has proved the device: a connection from anywhere but one of this
 * computer's networks (`admitConnection`) is dropped before a byte is read, requests that carry
 * proxy headers or a browser `Origin` are refused, and repeated failures from one address are
 * turned away for a while.
 */
export async function startNetworkListener(
  options: NetworkListenerOptions,
  port: number
): Promise<NetworkListener> {
  const admit: Admit = options.admit ?? ((local, remote) => admitConnection(local, remote))
  const now = options.now ?? Date.now
  const countsFailures = (source: string): boolean =>
    options.limitLoopback === true || !isLoopback(source)
  // Failures count per address, and per IPv6 /64 with a higher ceiling (`limitKey`): one address
  // cannot lock out its neighbours, and rotating addresses inside a /64 buys only so much.
  const byAddress = createFailureLimiter({ max: 5, windowMs: 60_000, now })
  const byNet = createFailureLimiter({ max: MAX_FAILURES_PER_NET, windowMs: 60_000, now })
  /**
   * Addresses that signed in lately: a /64's shared limit never turns them away, so a neighbour
   * failing on purpose cannot lock out the devices that already work.
   */
  const signedIn = new Map<string, number>()
  const SIGNED_IN_MS = 24 * 60 * 60 * 1000
  const recentlySignedIn = (source: string): boolean => {
    const at = signedIn.get(source)
    return at !== undefined && now() - at < SIGNED_IN_MS
  }
  const limiter = {
    blocked: (source: string): boolean =>
      byAddress.blocked(source) ||
      (source.includes(':') && byNet.blocked(limitKey(source)) && !recentlySignedIn(source)),
    fail(source: string): void {
      byAddress.fail(source)
      if (source.includes(':')) byNet.fail(limitKey(source))
    },
    reset(source: string): void {
      byAddress.reset(source)
      signedIn.delete(source)
      signedIn.set(source, now())
      // Oldest first: past a thousand, the earliest are forgotten.
      if (signedIn.size > 1000) signedIn.delete(signedIn.keys().next().value!)
    }
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: HANDSHAKE_MAX_BYTES })
  const sockets = new Set<Socket>()
  const byDevice = new Map<string, Set<Session>>()
  const perAddress = new Map<string, number>()
  /** Handshakes in flight per address, and per IPv6 /64 (`limitKey`). */
  const handshakingPer = new Map<string, number>()
  const handshakingPerNet = new Map<string, number>()
  /** Connections per IPv6 /64, beside `perAddress`. */
  const perNet = new Map<string, number>()
  const bump = (map: Map<string, number>, key: string, by: number): void => {
    const next = (map.get(key) ?? 0) + by
    if (next > 0) map.set(key, next)
    else map.delete(key)
  }
  let handshaking = 0
  let connected = 0

  const server: Server = createServer((_request, response) => {
    // Not a WebSocket upgrade: say nothing about what this is.
    response.writeHead(426, { 'content-length': '0', connection: 'close' }).end()
  })

  guardSockets(
    server,
    sockets,
    admit,
    (message) => options.log(`Remote access: ${message}`),
    recentlySignedIn
  )

  server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const source = sourceOf(socket)
    const refuse = (status: string, why: string): void => {
      options.log(`Remote access: refused ${source} (${why})`)
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    // Checked when the socket opened too; again here, since the computer may have left that
    // network since (the rule reads the interfaces as they are now).
    const outside = admit(targetOf(socket), source)
    if (outside) {
      options.log(`Remote access: dropped ${source || '?'} (${outside})`)
      socket.destroy()
      return
    }
    const net = limitKey(source)
    if (limiter.blocked(source)) return refuse('429 Too Many Requests', 'too many failed attempts')
    const proxy = proxyHeader(request.headers)
    if (proxy) return refuse('400 Bad Request', `proxy header ${proxy}`)
    // A browser page cannot be a paired device, and must not be able to try.
    if (request.headers.origin !== undefined) return refuse('403 Forbidden', 'browser origin')
    const path = (request.url ?? '').split('?')[0]
    if (path !== '/' && path !== '/ws') return refuse('404 Not Found', 'unknown path')
    if (
      handshaking >= MAX_HANDSHAKING ||
      (handshakingPer.get(source) ?? 0) >=
        (isLoopback(source) ? MAX_HANDSHAKING_PER_LOOPBACK : MAX_HANDSHAKING_PER_ADDRESS) ||
      (source.includes(':') &&
        !recentlySignedIn(source) &&
        (handshakingPerNet.get(net) ?? 0) >= MAX_HANDSHAKING_PER_NET) ||
      (perAddress.get(source) ?? 0) >= (isLoopback(source) ? MAX_PER_LOOPBACK : MAX_PER_ADDRESS) ||
      (source.includes(':') && !recentlySignedIn(source) && (perNet.get(net) ?? 0) >= MAX_PER_NET)
    ) {
      return refuse('429 Too Many Requests', 'too many open connections')
    }
    wss.handleUpgrade(request, socket, head, (ws) => accept(ws, source))
  })

  function accept(ws: WebSocket, source: string): void {
    const key = source
    const net = limitKey(source)
    handshaking++
    bump(handshakingPer, source, 1)
    bump(handshakingPerNet, net, 1)
    bump(perAddress, source, 1)
    bump(perNet, net, 1)
    /** Ends this connection's share of the handshake counts, once. */
    let handshakeCounted = true
    const handshakeDone = (): void => {
      if (!handshakeCounted) return
      handshakeCounted = false
      handshaking--
      bump(handshakingPer, source, -1)
      bump(handshakingPerNet, net, -1)
    }
    /**
     * The window this connection's request claimed when it was sent the host value: unless it
     * ends allowed, that window closes with it, so a peer gets one look at a code per window.
     */
    let claimed: PairingOffer | undefined
    let allowed = false
    let phase: 'handshake' | 'approval' | 'open' | 'closed' = 'handshake'
    /** The question on the host's screen while a request waits, withdrawn if the device goes. */
    let question: { withdraw(): void } | undefined
    let deviceId = ''
    let connection: ReturnType<Hub['connect']> | undefined
    let secure: SecureFrameChannel | undefined
    // Protocol 2 only: anything else, protocol 1's hello included, is closed with 4401 unanswered.
    const handshake = createSecureServerHandshake({
      store: options.store,
      maxMessageBytes: MAX_FRAME_BYTES,
      acceptsRequests: options.approvals !== undefined
    })
    /** Whether this side has answered yet: where a handshake that went quiet stopped, for the log. */
    let replied = false
    const stalled = (): string =>
      replied
        ? "got this computer's key and did not answer: the phone may not trust it; pair again with a new QR"
        : 'connected, but sent no hello'
    /**
     * Ends the session now: nothing the peer sends after this reaches the hub (a peer that ignores
     * the close frame would otherwise keep calling until `ws` gives up), and the socket is cut
     * if it does not close itself.
     */
    function end(code: number, reason: string): void {
      if (phase === 'closed') return
      phase = 'closed'
      question?.withdraw()
      question = undefined
      connection?.close()
      ws.close(code, reason)
      setTimeout(() => ws.terminate(), 1000).unref()
    }
    const session: Session = { end: (code, reason) => end(code, reason) }
    let timeout = setTimeout(() => {
      options.log(`Remote access: ${source} did not finish the handshake (${stalled()})`)
      if (countsFailures(source)) limiter.fail(key)
      end(CLOSE.TIMEOUT, 'timeout')
    }, options.handshakeMs ?? HANDSHAKE_TIMEOUT_MS)
    let alive = true
    const ping = setInterval(() => {
      if (phase !== 'open') return
      // Removed from another process (the CLI): this process's store has not heard.
      options.store.reload()
      if (!options.store.hasDevice(deviceId)) return end(CLOSE.REVOKED, 'removed')
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, options.pingMs ?? 20_000)
    timeout.unref()
    ping.unref()
    ws.on('pong', () => (alive = true))

    ws.on('message', (data: RawData, isBinary: boolean) => {
      alive = true
      if (phase === 'closed') return
      if (isBinary) {
        if (phase === 'handshake' && countsFailures(source)) limiter.fail(key)
        return end(CLOSE.BAD_REQUEST, 'text frames only')
      }
      const frame = rawToString(data)
      if (phase === 'open') {
        let text: string | undefined
        try {
          text = secure!.open(frame)
        } catch (error) {
          // Tampered, replayed, reordered or after a dropped frame: the session is over.
          options.log(`Remote access: ended ${deviceId} from ${source} (${String(error)})`)
          return end(CLOSE.BAD_REQUEST, 'bad frame')
        }
        if (text === undefined) return
        connection?.receive(text.endsWith('\n') ? text : `${text}\n`)
        return
      }
      if (phase === 'approval') {
        // Nothing may come before the answer; the handshake refuses it and the device is let go.
        options.log(`Remote access: ${source} sent a message before its request was answered`)
        if (countsFailures(source)) limiter.fail(key)
        return end(CLOSE.UNAUTHORIZED, 'unauthorized')
      }
      if (phase !== 'handshake') return
      let outcome: ReturnType<typeof handshake.receive>
      try {
        outcome = handshake.receive(frame)
      } catch (error) {
        // The host's key could not be read (the keychain refused): this connection cannot go on.
        outcome = { kind: 'denied', frames: [], reason: String(error) }
      }
      if (outcome.kind === 'approval') return awaitApproval(outcome)
      for (const reply of outcome.frames) ws.send(reply)
      if (outcome.kind === 'reply') replied = true
      if (outcome.kind === 'reply' && outcome.claimed) claimed = outcome.claimed
      if (outcome.kind === 'denied') {
        options.log(`Remote access: refused ${source} (${outcome.reason})`)
        if (countsFailures(source)) limiter.fail(key)
        end(CLOSE.UNAUTHORIZED, 'unauthorized')
        return
      }
      if (outcome.kind === 'ready') {
        limiter.reset(key)
        secure = outcome.channel
        open(outcome.deviceId, outcome.paired)
      }
    })

    /**
     * A device asks to pair by approval: the question goes to the host's screen and the connection
     * waits, with no hub and nothing sent, until the person answers, the device leaves or the time
     * runs out. Only one question at a time; another device asking meanwhile is told the host is busy.
     */
    function awaitApproval(
      request: Extract<ReturnType<typeof handshake.receive>, { kind: 'approval' }>
    ) {
      const decided = (allow: boolean): void => {
        if (phase !== 'approval') return
        question = undefined
        const result = request.decide(allow)
        if (result.kind !== 'ready') {
          options.log(
            `Remote access: ${source}'s request was not allowed (${result.kind === 'denied' ? result.reason : '?'})`
          )
          if (countsFailures(source)) limiter.fail(key)
          return end(CLOSE.UNAUTHORIZED, 'unauthorized')
        }
        phase = 'handshake'
        allowed = true
        for (const reply of result.frames) ws.send(reply)
        limiter.reset(key)
        secure = result.channel
        open(result.deviceId, true)
      }
      const asked = options.approvals?.ask(
        { name: request.name, code: request.code, source },
        decided
      )
      if (!asked) {
        options.log(
          `Remote access: refused ${source}'s request to pair (${options.approvals ? 'another request is waiting' : 'this host takes no requests'})`
        )
        return end(options.approvals ? CLOSE.BUSY : CLOSE.UNAUTHORIZED, 'not now')
      }
      question = asked
      phase = 'approval'
      options.log(
        `Remote access: ${source} asks to pair as "${request.name}"; waiting for an answer`
      )
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        options.log(`Remote access: ${source}'s request to pair was not answered in time`)
        // Counted, so one peer cannot hold the only question slot by asking again and again.
        if (countsFailures(source)) limiter.fail(key)
        end(CLOSE.TIMEOUT, 'timeout')
      }, options.approvalMs ?? APPROVAL_TIMEOUT_MS)
      timeout.unref()
    }

    function open(id: string, paired: boolean): void {
      clearTimeout(timeout)
      phase = 'open'
      deviceId = id
      handshakeDone()
      // Past the handshake the frame limit is one Noise record's, not the handshake's: a longer
      // message is split into records, each one frame.
      setMaxPayload(ws, SECURE_FRAME_MAX_CHARS)
      const sessions = byDevice.get(id) ?? new Set<Session>()
      sessions.add(session)
      byDevice.set(id, sessions)
      connected++
      counted = true
      options.store.touch(id)
      options.log(
        `Remote access: ${paired ? 'paired and connected' : 'connected'} ${id} from ${source}`
      )
      options.onConnections?.(connected)
      connection = options.hub.connect((line) => {
        if (ws.readyState !== ws.OPEN) return
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return ws.terminate()
        const message = line.endsWith('\n') ? line.slice(0, -1) : line
        for (const frame of secure!.seal(message)) ws.send(frame)
      }, options.policy())
    }

    /** Counted in `connected` since `open()`. */
    let counted = false
    ws.on('close', () => {
      // A phone that does not trust the key it was shown hangs up without a word: say so here,
      // since nothing else in the log would.
      question?.withdraw()
      question = undefined
      if (phase === 'handshake' && replied) {
        options.log(`Remote access: ${source} hung up at the key check (${stalled()})`)
      }
      // A peer that hangs up before signing in counts as a failed attempt, as one the host ends
      // does: otherwise it could open, wait and close forever, holding handshake slots for free.
      if ((phase === 'handshake' || phase === 'approval') && countsFailures(source)) {
        limiter.fail(key)
      }
      clearTimeout(timeout)
      clearInterval(ping)
      const wasOpen = counted
      counted = false
      phase = 'closed'
      handshakeDone()
      bump(perAddress, source, -1)
      bump(perNet, net, -1)
      if (claimed && !allowed && options.store.pairing() === claimed) {
        // It could have worked out this window's code and walked away to try again: the window
        // closes, and the person at this computer makes a new code if they still want one.
        options.log(
          `Remote access: ${source} began pairing and stopped; Add device was closed so no other code can be tried`
        )
        options.store.cancelPairing(claimed)
      }
      connection?.close()
      if (!wasOpen) return
      const sessions = byDevice.get(deviceId)
      sessions?.delete(session)
      if (sessions?.size === 0) byDevice.delete(deviceId)
      connected--
      options.onConnections?.(connected)
    })
    // A peer that vanished or sent a bad frame (too large …) is a close, not a server error: `ws`
    // answers the frame with its close code and ends the socket itself.
    ws.on('error', () => undefined)
  }

  const unsubscribe = options.store.onRevoked((deviceId) => {
    options.log(`Remote access: ${deviceId} was removed; ending its connections`)
    listener.disconnectDevice(deviceId, CLOSE.REVOKED)
  })

  await listenOn(server, port, options.host)
  // A later error is logged; the listener is the owner's to restart.
  server.on('error', (error) => options.log(`Remote access: listener error: ${String(error)}`))

  const bound = server.address()
  const listener: NetworkListener = {
    address:
      bound && typeof bound === 'object'
        ? { address: bound.address, port: bound.port }
        : { address: options.host ?? '::', port },
    connections: () => connected,
    connectedDevices: () => [...byDevice.keys()],
    disconnectDevice(deviceId, code = CLOSE.REVOKED) {
      for (const session of [...(byDevice.get(deviceId) ?? [])]) session.end(code, 'removed')
    },
    close() {
      unsubscribe()
      return new Promise((resolve) => {
        options.hub.closeAll()
        wss.close()
        for (const ws of wss.clients) ws.terminate()
        server.close(() => resolve())
        for (const socket of sockets) socket.destroy()
      })
    }
  }
  return listener
}

/** Open TCP sockets one address may hold, upgraded or not: above every per-address cap. */
export const MAX_SOCKETS_PER_ADDRESS = 2 * MAX_PER_ADDRESS
const MAX_SOCKETS_PER_LOOPBACK = 2 * MAX_PER_LOOPBACK

/**
 * Listens on every interface, IPv4 and IPv6 on one dual-stack socket; where IPv6 is switched off,
 * on every IPv4 interface. `admitConnection` then decides per socket, so listening everywhere is
 * not reaching everywhere. `host` pins one address (tests).
 */
async function listenOn(server: Server, port: number, host?: string): Promise<void> {
  const attempt = (address: string, ipv6Only?: boolean): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: address, port, ...(ipv6Only === false ? { ipv6Only } : {}) }, () => {
        server.off('error', reject)
        resolve()
      })
    })
  if (host) return attempt(host)
  try {
    await attempt('::', false)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EAFNOSUPPORT' && code !== 'EADDRNOTAVAIL') throw error
    await attempt('0.0.0.0')
  }
}

/**
 * What every socket goes through before HTTP reads a byte: one from outside this computer's
 * networks (`admit`) is dropped, and so is one address's socket past `MAX_SOCKETS_PER_ADDRESS`,
 * since the per-address caps count only upgraded connections and an idle one would otherwise hold
 * a file descriptor until Node's header timeout. That timeout is the handshake's here.
 */
export function guardSockets(
  server: Server,
  sockets: Set<Socket>,
  admit: Admit,
  log: (message: string) => void,
  /** An address that signed in lately: its /64's shared cap does not apply to it. */
  trusted: (source: string) => boolean = () => false
) {
  server.headersTimeout = HANDSHAKE_TIMEOUT_MS
  server.requestTimeout = HANDSHAKE_TIMEOUT_MS
  const perAddress = new Map<string, number>()
  /** Open sockets per IPv6 /64 (`limitKey`); an IPv4 address is its own. */
  const perNetSockets = new Map<string, number>()
  server.on('connection', (socket: Socket) => {
    const source = sourceOf(socket)
    const outside = admit(targetOf(socket), source)
    if (outside) {
      log(`dropped a connection from ${source || '?'} (${outside})`)
      socket.destroy()
      return
    }
    const key = source
    const net = limitKey(source)
    const open = perAddress.get(key) ?? 0
    if (
      source.includes(':') &&
      !trusted(source) &&
      (perNetSockets.get(net) ?? 0) >= 2 * MAX_PER_NET
    ) {
      log(`dropped ${source} (too many open sockets from its network)`)
      socket.destroy()
      return
    }
    if (open >= (isLoopback(source) ? MAX_SOCKETS_PER_LOOPBACK : MAX_SOCKETS_PER_ADDRESS)) {
      log(`dropped ${source} (too many open sockets)`)
      socket.destroy()
      return
    }
    perAddress.set(key, open + 1)
    perNetSockets.set(net, (perNetSockets.get(net) ?? 0) + 1)
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
      const left = (perAddress.get(key) ?? 1) - 1
      if (left > 0) perAddress.set(key, left)
      else perAddress.delete(key)
      const netLeft = (perNetSockets.get(net) ?? 1) - 1
      if (netLeft > 0) perNetSockets.set(net, netLeft)
      else perNetSockets.delete(net)
    })
    socket.on('error', () => socket.destroy())
  })
}

/** `ws` takes the frame limit at construction; past the opening step a peer's frames may grow. */
export function setMaxPayload(ws: WebSocket, bytes: number): void {
  const receiver = (ws as unknown as { _receiver?: { _maxPayload: number } })._receiver
  if (receiver) receiver._maxPayload = bytes
}

export function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}
