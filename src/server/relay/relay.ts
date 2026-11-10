import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import {
  addressKind,
  bindAddressProblem,
  isPrivateAddress,
  proxyHeader
} from '@host/remoteAccess/addresses.js'
import {
  HANDSHAKE_MAX_BYTES,
  HANDSHAKE_TIMEOUT_MS,
  fingerprintOf,
  signatureValid
} from '@host/remoteAccess/handshake.js'
import { createFailureLimiter } from '@host/remoteAccess/rateLimit.js'
import {
  FINGERPRINT,
  RELAY_CLOSE,
  RELAY_FRAME_MAX_CHARS,
  RELAY_HOST_MESSAGE_MAX_CHARS,
  RELAY_HOST_PATH,
  RELAY_PHONE_PREFIX,
  hostToRelaySchema,
  relayRegisterSchema,
  relayRegistrationData,
  type RelayToHost
} from '@host/remoteAccess/relayProtocol.js'
import { MAX_BUFFERED_BYTES, rawToString } from '../wsListener.js'
import type { AllowList } from './allowList.js'

/** How far one session may fall behind toward its host before it alone is ended. */
export const MAX_SESSION_BUFFERED_BYTES = 8 * 1024 * 1024
/** Devices one host may have through the relay at once. */
export const MAX_SESSIONS_PER_HOST = 32
const MAX_REGISTERING = 16
const MAX_PER_ADDRESS = 8
/** Every endpoint behind an ssh tunnel is 127.0.0.1, so loopback gets a larger share. */
const MAX_PER_LOOPBACK = 32

export interface RelayOptions {
  allowList: AllowList
  log(message: string): void
  now?(): number
  /** Liveness pings, in ms; an endpoint that left the network is dropped after one missed. */
  pingMs?: number
  registerMs?: number
  /** Count failures from loopback too (tests); a tunnel shares one address, so it is off. */
  limitLoopback?: boolean
  /** Tests: a smaller per-session backlog toward the host. */
  maxSessionBufferedBytes?: number
}

export interface Relay {
  address: { address: string; port: number }
  /** The registered hosts, with how many sessions each has. */
  hosts(): { fingerprint: string; sessions: number }[]
  /** Ends a host's registration and every session through it (revoked from the allow list). */
  disconnectHost(fingerprint: string): void
  close(): Promise<void>
}

interface HostLink {
  fingerprint: string
  sessions: Map<string, PhoneSession>
  send(message: RelayToHost, sent?: (error?: Error) => void): void
  end(code: number, reason: string): void
}

interface PhoneSession {
  id: string
  /** Bytes sent toward the host that it has not taken yet. */
  pending: number
  /** Ends the session on the relay's side: the phone gets `code`, the host is told. */
  end(code: number, reason: string): void
  /** Sends the host's frame to the phone. */
  deliver(frame: string): void
}

const isLoopback = (source: string): boolean => addressKind(source) === 'loopback'

/**
 * `styr relay`: forwards phones to hosts on the owner's tailnet, so neither has to accept a
 * connection (`docs/architecture/remote-access.md`, Relay). It is trusted for admission and
 * availability only: a host proves its key and must be on the allow list, and a phone's frames are
 * moved without being read (the session is end-to-end protocol 2). A phone asking for a host that
 * is offline, unknown or not allowed is told the same thing, 4404, and nothing else.
 *
 * Bound to one loopback or Tailscale address, with the listener's checks on every connection:
 * a public source is dropped before a byte is read, proxy headers and browser origins are refused,
 * and connections, failures and backlogs are capped as `wsListener.ts` caps them.
 */
export async function startRelay(
  options: RelayOptions,
  bindAddress: string,
  port: number
): Promise<Relay> {
  const problem = bindAddressProblem(bindAddress)
  if (problem) throw new Error(problem)
  const now = options.now ?? Date.now
  const sessionLimit = options.maxSessionBufferedBytes ?? MAX_SESSION_BUFFERED_BYTES
  const countsFailures = (source: string): boolean =>
    options.limitLoopback === true || !isLoopback(source)
  /** Failed host registrations: a bad signature, a key not allowed, a stalled or bad message. */
  const failures = createFailureLimiter({ max: 5, windowMs: 60_000, now })
  /** Phones told 4404: generous, since a phone retries while its host is away. */
  const misses = createFailureLimiter({ max: 30, windowMs: 60_000, now })
  const wss = new WebSocketServer({ noServer: true, maxPayload: HANDSHAKE_MAX_BYTES })
  const sockets = new Set<Socket>()
  const perAddress = new Map<string, number>()
  const hosts = new Map<string, HostLink>()
  let registering = 0

  const server: Server = createServer((_request, response) => {
    // Not a WebSocket upgrade: say nothing about what this is.
    response.writeHead(426, { 'content-length': '0', connection: 'close' }).end()
  })

  server.on('connection', (socket) => {
    const source = socket.remoteAddress ?? ''
    if (!isPrivateAddress(source)) {
      options.log(`Relay: dropped a connection from the public address ${source || '?'}`)
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
  })

  server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const source = socket.remoteAddress ?? ''
    const refuse = (status: string, why: string): void => {
      options.log(`Relay: refused ${source} (${why})`)
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    if (!isPrivateAddress(source)) {
      options.log(`Relay: dropped ${source || '?'} (not a private address)`)
      socket.destroy()
      return
    }
    const proxy = proxyHeader(request.headers)
    if (proxy) return refuse('400 Bad Request', `proxy header ${proxy}`)
    if (request.headers.origin !== undefined) return refuse('403 Forbidden', 'browser origin')
    const path = (request.url ?? '').split('?')[0] ?? ''
    const phoneFor = path.startsWith(RELAY_PHONE_PREFIX)
      ? path.slice(RELAY_PHONE_PREFIX.length)
      : undefined
    const isHost = path === RELAY_HOST_PATH
    if (!isHost && (phoneFor === undefined || !FINGERPRINT.test(phoneFor))) {
      return refuse('404 Not Found', 'unknown path')
    }
    if ((isHost ? failures : misses).blocked(source)) {
      return refuse('429 Too Many Requests', 'too many failed attempts')
    }
    if (
      (isHost && registering >= MAX_REGISTERING) ||
      (perAddress.get(source) ?? 0) >= (isLoopback(source) ? MAX_PER_LOOPBACK : MAX_PER_ADDRESS)
    ) {
      return refuse('429 Too Many Requests', 'too many open connections')
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      perAddress.set(source, (perAddress.get(source) ?? 0) + 1)
      ws.once('close', () => {
        const count = (perAddress.get(source) ?? 1) - 1
        if (count > 0) perAddress.set(source, count)
        else perAddress.delete(source)
      })
      // A peer that vanished or sent a bad frame (too large …) is a close, not a relay error.
      ws.on('error', () => undefined)
      if (isHost) acceptHost(ws, source)
      else acceptPhone(ws, source, phoneFor!)
    })
  })

  /** Pings `ws` while it lives; one missed pong cuts it. */
  function keepAlive(ws: WebSocket): void {
    let alive = true
    ws.on('pong', () => (alive = true))
    ws.on('message', () => (alive = true))
    const ping = setInterval(() => {
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, options.pingMs ?? 20_000)
    ping.unref()
    ws.once('close', () => clearInterval(ping))
  }

  /** Closes `ws` with `code`, and cuts it if the peer does not close in time. */
  function closeSocket(ws: WebSocket, code: number, reason: string): void {
    ws.close(code, reason)
    setTimeout(() => ws.terminate(), 1000).unref()
  }

  function acceptHost(ws: WebSocket, source: string): void {
    registering++
    let phase: 'challenge' | 'registered' | 'closed' = 'challenge'
    let link: HostLink | undefined
    const nonce = randomBytes(16).toString('hex')
    keepAlive(ws)

    /** Takes the host off the relay: no phone reaches it from now on, and its sessions end. */
    const drop = (): void => {
      if (!link) return
      const dropped = link
      link = undefined
      if (hosts.get(dropped.fingerprint) === dropped) {
        hosts.delete(dropped.fingerprint)
        options.log(`Relay: host ${dropped.fingerprint} disconnected`)
      }
      for (const session of [...dropped.sessions.values()]) {
        session.end(RELAY_CLOSE.HOST_OFFLINE, 'host offline')
      }
    }
    const end = (code: number, reason: string): void => {
      if (phase === 'closed') return
      if (phase === 'challenge') registering--
      phase = 'closed'
      drop()
      closeSocket(ws, code, reason)
    }
    const refuse = (code: number, why: string): void => {
      options.log(`Relay: refused a host from ${source} (${why})`)
      if (countsFailures(source)) failures.fail(source)
      end(code, why)
    }
    const timeout = setTimeout(
      () => refuse(RELAY_CLOSE.TIMEOUT, 'did not register in time'),
      options.registerMs ?? HANDSHAKE_TIMEOUT_MS
    )
    timeout.unref()
    ws.send(JSON.stringify({ type: 'challenge', nonce }))

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (phase === 'closed') return
      if (isBinary) {
        if (phase === 'challenge') return refuse(RELAY_CLOSE.BAD_REQUEST, 'binary frame')
        return end(RELAY_CLOSE.BAD_REQUEST, 'text frames only')
      }
      const parsed = parseJson(rawToString(data))
      if (phase === 'registered') return fromHost(link!, parsed)
      clearTimeout(timeout)
      const register = relayRegisterSchema.safeParse(parsed)
      if (!register.success) return refuse(RELAY_CLOSE.BAD_REQUEST, 'not a registration')
      const { hostKey, signature } = register.data
      // The signature first: only the key's holder learns whether it is allowed here.
      if (!signatureValid(hostKey, relayRegistrationData(nonce), signature)) {
        return refuse(RELAY_CLOSE.UNAUTHORIZED, 'bad signature')
      }
      const fingerprint = fingerprintOf(hostKey)
      options.allowList.reload()
      if (!options.allowList.has(fingerprint)) {
        return refuse(RELAY_CLOSE.NOT_ALLOWED, `${fingerprint} is not on the allow list`)
      }
      failures.reset(source)
      registering--
      phase = 'registered'
      // Past registration a message is a frame and its envelope.
      setMaxPayload(ws, RELAY_HOST_MESSAGE_MAX_CHARS)
      link = registerHost(ws, fingerprint, end)
      options.log(`Relay: host ${fingerprint} registered from ${source}`)
    })

    ws.once('close', () => {
      clearTimeout(timeout)
      // Hung up before registering: as good as a failed attempt.
      if (phase === 'challenge') {
        registering--
        if (countsFailures(source)) failures.fail(source)
      }
      phase = 'closed'
      drop()
    })
  }

  /** Makes `ws` the host for `fingerprint`, ending an older registration of the same key. */
  function registerHost(
    ws: WebSocket,
    fingerprint: string,
    end: (code: number, reason: string) => void
  ): HostLink {
    hosts.get(fingerprint)?.end(RELAY_CLOSE.REPLACED, 'registered again')
    const link: HostLink = {
      fingerprint,
      sessions: new Map(),
      send(message, sent) {
        if (ws.readyState !== ws.OPEN) return
        // The host's one socket carries every session: past this it is cut, and all of them end.
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return ws.terminate()
        ws.send(JSON.stringify(message), sent)
      },
      end
    }
    hosts.set(fingerprint, link)
    link.send({ type: 'registered' })
    return link
  }

  /** A message from a registered host: a frame for a phone, or the end of a session. */
  function fromHost(link: HostLink, parsed: unknown): void {
    const message = hostToRelaySchema.safeParse(parsed)
    if (!message.success) {
      options.log(`Relay: host ${link.fingerprint} sent a bad message; closing it`)
      return link.end(RELAY_CLOSE.BAD_REQUEST, 'bad message')
    }
    const session = link.sessions.get(message.data.sessionId)
    // Ended by the phone a moment ago: the host has not heard yet.
    if (!session) return
    if (message.data.type === 'close') return session.end(message.data.code ?? 1000, '')
    session.deliver(message.data.frame)
  }

  function acceptPhone(ws: WebSocket, source: string, fingerprint: string): void {
    const link = hosts.get(fingerprint)
    if (!link) {
      // Offline, unknown or not allowed: the phone cannot tell which.
      if (countsFailures(source)) misses.fail(source)
      return closeSocket(ws, RELAY_CLOSE.HOST_OFFLINE, 'host offline')
    }
    if (link.sessions.size >= MAX_SESSIONS_PER_HOST) {
      options.log(`Relay: refused ${source} (host ${fingerprint} has too many sessions)`)
      return closeSocket(ws, RELAY_CLOSE.BUSY, 'busy')
    }
    setMaxPayload(ws, RELAY_FRAME_MAX_CHARS)
    keepAlive(ws)
    let open = true
    const session: PhoneSession = {
      id: randomBytes(8).toString('hex'),
      pending: 0,
      end(code, reason) {
        if (!open) return
        open = false
        link.sessions.delete(session.id)
        link.send({ type: 'close', sessionId: session.id })
        closeSocket(ws, code, reason)
      },
      deliver(frame) {
        if (!open || ws.readyState !== ws.OPEN) return
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          options.log(`Relay: a phone of ${fingerprint} fell too far behind; ending its session`)
          return session.end(RELAY_CLOSE.BUSY, 'too far behind')
        }
        ws.send(frame)
      }
    }
    link.sessions.set(session.id, session)
    link.send({ type: 'open', sessionId: session.id })
    options.log(`Relay: ${source} opened a session to ${fingerprint}`)

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (!open) return
      if (isBinary) return session.end(RELAY_CLOSE.BAD_REQUEST, 'text frames only')
      const frame = rawToString(data)
      const size = Buffer.byteLength(frame)
      if (session.pending + size > sessionLimit) {
        options.log(`Relay: a session to ${fingerprint} fell too far behind; ending it`)
        return session.end(RELAY_CLOSE.BUSY, 'too far behind')
      }
      session.pending += size
      link.send({ type: 'frame', sessionId: session.id, frame }, () => {
        session.pending -= size
      })
    })
    ws.once('close', () => {
      if (!open) return
      open = false
      link.sessions.delete(session.id)
      link.send({ type: 'close', sessionId: session.id })
    })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: bindAddress, port }, () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.on('error', (error) => options.log(`Relay: listener error: ${String(error)}`))

  const bound = server.address()
  return {
    address:
      bound && typeof bound === 'object'
        ? { address: bound.address, port: bound.port }
        : { address: bindAddress, port },
    hosts: () =>
      [...hosts.values()].map((link) => ({
        fingerprint: link.fingerprint,
        sessions: link.sessions.size
      })),
    disconnectHost(fingerprint) {
      hosts.get(fingerprint)?.end(RELAY_CLOSE.NOT_ALLOWED, 'revoked')
    },
    close() {
      return new Promise((resolve) => {
        wss.close()
        for (const ws of wss.clients) ws.terminate()
        server.close(() => resolve())
        for (const socket of sockets) socket.destroy()
      })
    }
  }
}

/** `ws` takes the limit at construction; past the opening step an endpoint's frames may grow. */
function setMaxPayload(ws: WebSocket, bytes: number): void {
  const receiver = (ws as unknown as { _receiver?: { _maxPayload: number } })._receiver
  if (receiver) receiver._maxPayload = bytes
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
