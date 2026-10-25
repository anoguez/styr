import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import type { AccessStore } from '@host/remoteAccess/accessStore.js'
import { isPrivateAddress, proxyHeader } from '@host/remoteAccess/addresses.js'
import type { ClientPolicy } from '@host/remoteAccess/gate.js'
import {
  HANDSHAKE_MAX_BYTES,
  HANDSHAKE_TIMEOUT_MS,
  createServerHandshake
} from '@host/remoteAccess/handshake.js'
import { createFailureLimiter } from '@host/remoteAccess/rateLimit.js'
import type { Hub } from './hub.js'

/** The largest message a signed-in client may send. Terminal input and task drafts are far below. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024
/** As on the Unix socket: a client this far behind is dropped rather than buffered. */
export const MAX_BUFFERED_BYTES = 32 * 1024 * 1024
const MAX_HANDSHAKING = 16
const MAX_PER_ADDRESS = 8

/** WebSocket close codes the listener uses (4000–4999 are for applications). */
export const CLOSE = {
  BAD_REQUEST: 4400,
  UNAUTHORIZED: 4401,
  REVOKED: 4403,
  TIMEOUT: 4408,
  BUSY: 4429
} as const

export interface NetworkListenerOptions {
  hub: Hub
  store: AccessStore
  /** One per connection: it remembers what that device opened. */
  policy: () => ClientPolicy
  protocol: number
  log(message: string): void
  now?(): number
  /** Liveness pings, in ms; a phone that left the network is dropped after one missed. */
  pingMs?: number
  handshakeMs?: number
  /** Told how many devices are connected, each time it changes. */
  onConnections?(count: number): void
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

/** The source address of a request, as the socket saw it. */
const sourceOf = (socket: Socket): string => socket.remoteAddress ?? ''

/**
 * Listens for devices on one private address. Nothing reaches the hub before the handshake
 * (`handshake.ts`) has proved the device: connections from a public address are dropped before
 * a byte is read, requests that carry proxy headers or a browser `Origin` are refused, and
 * repeated failures from one address are turned away for a while.
 */
export async function startNetworkListener(
  options: NetworkListenerOptions,
  bindAddress: string,
  port: number
): Promise<NetworkListener> {
  const now = options.now ?? Date.now
  const limiter = createFailureLimiter({ max: 5, windowMs: 60_000, now })
  const wss = new WebSocketServer({ noServer: true, maxPayload: HANDSHAKE_MAX_BYTES })
  const sockets = new Set<Socket>()
  const byDevice = new Map<string, Set<WebSocket>>()
  const perAddress = new Map<string, number>()
  let handshaking = 0
  let connected = 0

  const server: Server = createServer((_request, response) => {
    // Not a WebSocket upgrade: say nothing about what this is.
    response.writeHead(426, { 'content-length': '0', connection: 'close' }).end()
  })

  server.on('connection', (socket) => {
    const source = sourceOf(socket)
    if (!isPrivateAddress(source)) {
      options.log(`Remote access: dropped a connection from the public address ${source || '?'}`)
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
  })

  server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const source = sourceOf(socket)
    const refuse = (status: string, why: string): void => {
      options.log(`Remote access: refused ${source} (${why})`)
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    if (!isPrivateAddress(source)) {
      options.log(`Remote access: dropped ${source || '?'} (not a private address)`)
      socket.destroy()
      return
    }
    if (limiter.blocked(source)) return refuse('429 Too Many Requests', 'too many failed attempts')
    const proxy = proxyHeader(request.headers)
    if (proxy) return refuse('400 Bad Request', `proxy header ${proxy}`)
    // A browser page cannot be a paired device, and must not be able to try.
    if (request.headers.origin !== undefined) return refuse('403 Forbidden', 'browser origin')
    const path = (request.url ?? '').split('?')[0]
    if (path !== '/' && path !== '/ws') return refuse('404 Not Found', 'unknown path')
    if (handshaking >= MAX_HANDSHAKING || (perAddress.get(source) ?? 0) >= MAX_PER_ADDRESS) {
      return refuse('429 Too Many Requests', 'too many open connections')
    }
    wss.handleUpgrade(request, socket, head, (ws) => accept(ws, source))
  })

  function accept(ws: WebSocket, source: string): void {
    handshaking++
    perAddress.set(source, (perAddress.get(source) ?? 0) + 1)
    let phase: 'handshake' | 'open' | 'closed' = 'handshake'
    let deviceId = ''
    let connection: ReturnType<Hub['connect']> | undefined
    const handshake = createServerHandshake({ store: options.store, protocol: options.protocol })
    const timeout = setTimeout(() => {
      options.log(`Remote access: ${source} did not finish the handshake`)
      limiter.fail(source)
      ws.close(CLOSE.TIMEOUT, 'timeout')
    }, options.handshakeMs ?? HANDSHAKE_TIMEOUT_MS)
    let alive = true
    const ping = setInterval(() => {
      if (phase !== 'open') return
      // Removed from another process (the CLI): this process's store has not heard.
      options.store.reload()
      if (!options.store.hasDevice(deviceId)) return ws.close(CLOSE.REVOKED, 'removed')
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, options.pingMs ?? 20_000)
    timeout.unref()
    ping.unref()
    ws.on('pong', () => (alive = true))

    ws.on('message', (data: RawData, isBinary: boolean) => {
      alive = true
      if (isBinary) {
        if (phase === 'handshake') limiter.fail(source)
        return ws.close(CLOSE.BAD_REQUEST, 'text frames only')
      }
      const text = rawToString(data)
      if (phase === 'open') {
        connection?.receive(text.endsWith('\n') ? text : `${text}\n`)
        return
      }
      if (phase !== 'handshake') return
      const outcome = handshake.receive(text)
      for (const message of outcome.messages) ws.send(JSON.stringify(message))
      if (outcome.kind === 'denied') {
        options.log(`Remote access: refused ${source} (${outcome.reason})`)
        limiter.fail(source)
        phase = 'closed'
        ws.close(CLOSE.UNAUTHORIZED, 'unauthorized')
        return
      }
      if (outcome.kind === 'ready') {
        limiter.reset(source)
        open(outcome.deviceId, outcome.paired)
      }
    })

    function open(id: string, paired: boolean): void {
      clearTimeout(timeout)
      phase = 'open'
      deviceId = id
      handshaking--
      handshakeCounted = false
      // Past the handshake the frame limit is the session's, not the handshake's.
      const receiver = (ws as unknown as { _receiver?: { _maxPayload: number } })._receiver
      if (receiver) receiver._maxPayload = MAX_FRAME_BYTES
      const sessions = byDevice.get(id) ?? new Set<WebSocket>()
      sessions.add(ws)
      byDevice.set(id, sessions)
      connected++
      options.store.touch(id)
      options.log(
        `Remote access: ${paired ? 'paired and connected' : 'connected'} ${id} from ${source}`
      )
      options.onConnections?.(connected)
      connection = options.hub.connect((line) => {
        if (ws.readyState !== ws.OPEN) return
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return ws.terminate()
        ws.send(line.endsWith('\n') ? line.slice(0, -1) : line)
      }, options.policy())
    }

    let handshakeCounted = true
    ws.on('close', () => {
      clearTimeout(timeout)
      clearInterval(ping)
      const wasOpen = phase === 'open'
      phase = 'closed'
      if (handshakeCounted) handshaking--
      handshakeCounted = false
      const count = (perAddress.get(source) ?? 1) - 1
      if (count > 0) perAddress.set(source, count)
      else perAddress.delete(source)
      connection?.close()
      if (!wasOpen) return
      const sessions = byDevice.get(deviceId)
      sessions?.delete(ws)
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

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: bindAddress, port }, () => {
      server.off('error', reject)
      resolve()
    })
  })
  // A later error (the interface went away) is logged; the listener is the owner's to restart.
  server.on('error', (error) => options.log(`Remote access: listener error: ${String(error)}`))

  const bound = server.address()
  const listener: NetworkListener = {
    address:
      bound && typeof bound === 'object'
        ? { address: bound.address, port: bound.port }
        : { address: bindAddress, port },
    connections: () => connected,
    connectedDevices: () => [...byDevice.keys()],
    disconnectDevice(deviceId, code = CLOSE.REVOKED) {
      for (const ws of [...(byDevice.get(deviceId) ?? [])]) ws.close(code, 'removed')
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

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}
