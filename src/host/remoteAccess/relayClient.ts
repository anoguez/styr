import type { RelayStatus } from '@core/types/access.js'
import type { AccessStore } from './accessStore.js'
import { addressKind } from './addresses.js'
import { HANDSHAKE_TIMEOUT_MS } from './handshake.js'
import {
  RELAY_CLOSE,
  RELAY_HOST_PATH,
  relayChallengeSchema,
  relayRegistrationData,
  relayToHostSchema,
  type HostToRelay
} from './relayProtocol.js'
import { createSecureServerHandshake, type SecureFrameChannel } from './secureSession.js'

/**
 * The host's side of `styr relay` (`docs/architecture/remote-access.md`, Relay): one outbound
 * socket to the relay, and on it one protocol-2 session per device the relay forwards. Each session
 * runs the handshake a direct socket runs (`createSecureServerHandshake`, protocol 2 only: a relay
 * must not be able to downgrade it) and then joins the hub with the network policy, so the gate and
 * each workspace's `remoteAccess` apply as they do to a direct connection.
 *
 * The only timers are the reconnect backoff, the liveness ping while connected and each session's
 * handshake timeout, as on the listener.
 */

/** The socket to the relay, as the transport gives it (`ws` in `src/server/networkAccess.ts`). */
export interface RelaySocket {
  /** Bytes queued and not yet written. */
  readonly bufferedAmount: number
  send(text: string): void
  ping(): void
  close(code?: number, reason?: string): void
  terminate(): void
}

export interface RelaySocketEvents {
  open(): void
  message(text: string, isBinary: boolean): void
  pong(): void
  close(code: number, reason: string): void
  error(error: Error): void
}

/** A signed-in device's place on the hub, filtered by the network policy. */
export interface RelayHubSession {
  receive(text: string): void
  close(): void
}

export interface RelayClientPorts {
  store: AccessStore
  /** Opens a WebSocket to `url`; nothing is sent until `open`. */
  dial(url: string, events: RelaySocketEvents): RelaySocket
  /** Joins the hub for one signed-in device, with a fresh network policy. */
  connect(send: (line: string) => void): RelayHubSession
  log(message: string): void
  /** The link changed: connected, refused, unreachable … */
  onStatus?(status: RelayStatus, error: string | undefined): void
  /** How many devices are signed in through the relay, each time it changes. */
  onConnections?(count: number): void
  /** The longest JSON-RPC message a device may send. */
  maxMessageBytes: number
  /** The link this far behind (a relay that stopped reading) is cut and dialled again. */
  maxBufferedBytes: number
  /** Liveness pings, in ms; a relay that missed one is dropped and dialled again. */
  pingMs?: number
  handshakeMs?: number
  /** Reconnect delays: doubled from `firstMs` after each failure, up to `maxMs`. */
  backoff?: { firstMs: number; maxMs: number }
}

export interface RelayClient {
  status(): RelayStatus
  error(): string | undefined
  /** The devices signed in through the relay. */
  connectedDevices(): string[]
  /** Sessions open right now, handshaking or signed in. */
  sessions(): number
  disconnectDevice(deviceId: string, code?: number): void
  close(): Promise<void>
}

/** Devices mid-handshake at once: everyone behind the relay shares it, so this is per link. */
export const MAX_RELAY_HANDSHAKING = 16
const PING_MS = 20_000
const BACKOFF = { firstMs: 1_000, maxMs: 60_000 }

/** Close codes toward a device, as a direct socket uses them (`wsListener.ts`). */
const SESSION_CLOSE = {
  BAD_REQUEST: 4400,
  UNAUTHORIZED: 4401,
  REVOKED: 4403,
  TIMEOUT: 4408,
  BUSY: 4429
} as const

/** Why the relay address cannot be used, or undefined: a loopback or Tailscale IP only. */
export function relayAddressProblem(address: string): string | undefined {
  const trimmed = address.trim()
  if (!trimmed) return "Type the relay's address."
  if (!addressKind(trimmed)) {
    return `${trimmed} is not a Tailscale or loopback IP address. A relay is reached over Tailscale (100.64.0.0/10) or an ssh tunnel to 127.0.0.1 only.`
  }
  return undefined
}

export function relayUrl(address: string, port: number): string {
  const host = address.includes(':') ? `[${address}]` : address
  return `ws://${host}:${port}${RELAY_HOST_PATH}`
}

interface Session {
  id: string
  phase: 'handshake' | 'open'
  deviceId: string
  handshake: ReturnType<typeof createSecureServerHandshake>
  secure?: SecureFrameChannel
  hub?: RelayHubSession
  timeout: ReturnType<typeof setTimeout>
}

/** Connects to the relay at once, and again after every drop, until `close`. */
export function startRelayClient(
  ports: RelayClientPorts,
  address: string,
  port: number
): RelayClient {
  const backoff = ports.backoff ?? BACKOFF
  const where = `${address}:${port}`
  const sessions = new Map<string, Session>()
  const byDevice = new Map<string, Set<Session>>()
  let socket: RelaySocket | undefined
  let registered = false
  let alive = true
  let ping: ReturnType<typeof setInterval> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  let stopped = false
  let status: RelayStatus = 'connecting'
  let error: string | undefined
  /** Why the last dial failed, from the socket's error (ECONNREFUSED …), kept for its close. */
  let dialError: string | undefined
  /** The relay answered HTTP 429: too many refused registrations from here in the last minute. */
  let throttled = false

  function setStatus(next: RelayStatus, why?: string): void {
    if (next === status && why === error) return
    status = next
    error = why
    // Said once per change, so a relay that stays away does not fill the log on every retry.
    if (why) ports.log(`Remote access: relay: ${why}`)
    ports.onStatus?.(status, error)
  }

  function signedIn(): number {
    let count = 0
    for (const set of byDevice.values()) count += set.size
    return count
  }

  function sendToRelay(message: HostToRelay): void {
    const link = socket
    if (!link || !registered) return
    if (link.bufferedAmount > ports.maxBufferedBytes) {
      ports.log(`Remote access: the relay at ${where} is not reading; reconnecting`)
      link.terminate()
      return
    }
    link.send(JSON.stringify(message))
  }

  /** Ends a session here; `code` tells the relay to close the device's side with it. */
  function endSession(session: Session, code?: number): void {
    if (sessions.get(session.id) !== session) return
    sessions.delete(session.id)
    clearTimeout(session.timeout)
    session.hub?.close()
    if (code !== undefined) sendToRelay({ type: 'close', sessionId: session.id, code })
    if (session.phase !== 'open') return
    const set = byDevice.get(session.deviceId)
    set?.delete(session)
    if (set?.size === 0) byDevice.delete(session.deviceId)
    ports.onConnections?.(signedIn())
  }

  function openSession(sessionId: string): void {
    // The relay makes a fresh id for each phone; a repeat replaces the old session.
    const existing = sessions.get(sessionId)
    if (existing) endSession(existing)
    const handshaking = [...sessions.values()].filter((entry) => entry.phase === 'handshake')
    if (handshaking.length >= MAX_RELAY_HANDSHAKING) {
      ports.log('Remote access: too many devices signing in through the relay at once')
      sendToRelay({ type: 'close', sessionId, code: SESSION_CLOSE.BUSY })
      return
    }
    const session: Session = {
      id: sessionId,
      phase: 'handshake',
      deviceId: '',
      handshake: createSecureServerHandshake({
        store: ports.store,
        maxMessageBytes: ports.maxMessageBytes
      }),
      timeout: setTimeout(() => {
        ports.log(`Remote access: a device through the relay did not finish the handshake`)
        endSession(session, SESSION_CLOSE.TIMEOUT)
      }, ports.handshakeMs ?? HANDSHAKE_TIMEOUT_MS)
    }
    session.timeout.unref?.()
    sessions.set(sessionId, session)
  }

  function frame(sessionId: string, text: string): void {
    const session = sessions.get(sessionId)
    // Ended here a moment ago; the relay has not heard yet.
    if (!session) return
    if (session.phase === 'open') {
      let message: string | undefined
      try {
        message = session.secure!.open(text)
      } catch (failure) {
        // Tampered, replayed, reordered or after a dropped frame: the session is over.
        ports.log(`Remote access: ended ${session.deviceId} via the relay (${String(failure)})`)
        return endSession(session, SESSION_CLOSE.BAD_REQUEST)
      }
      if (message !== undefined) {
        session.hub?.receive(message.endsWith('\n') ? message : `${message}\n`)
      }
      return
    }
    let outcome: ReturnType<typeof session.handshake.receive>
    try {
      outcome = session.handshake.receive(text)
    } catch (failure) {
      outcome = { kind: 'denied', frames: [], reason: String(failure) }
    }
    for (const reply of outcome.frames) sendToRelay({ type: 'frame', sessionId, frame: reply })
    if (outcome.kind === 'denied') {
      ports.log(`Remote access: refused a device through the relay (${outcome.reason})`)
      return endSession(session, SESSION_CLOSE.UNAUTHORIZED)
    }
    if (outcome.kind !== 'ready') return
    clearTimeout(session.timeout)
    session.phase = 'open'
    session.deviceId = outcome.deviceId
    session.secure = outcome.channel
    const set = byDevice.get(outcome.deviceId) ?? new Set<Session>()
    set.add(session)
    byDevice.set(outcome.deviceId, set)
    ports.store.touch(outcome.deviceId)
    ports.log(
      `Remote access: ${outcome.paired ? 'paired and connected' : 'connected'} ` +
        `${outcome.deviceId} through the relay`
    )
    ports.onConnections?.(signedIn())
    const channel = outcome.channel
    session.hub = ports.connect((line) => {
      if (sessions.get(sessionId) !== session) return
      const message = line.endsWith('\n') ? line.slice(0, -1) : line
      for (const sealed of channel.seal(message)) {
        sendToRelay({ type: 'frame', sessionId, frame: sealed })
      }
    })
  }

  /** Drops the link: every session through it ends, and the relay is dialled again unless stopped. */
  function dropLink(link: RelaySocket, code?: number): void {
    if (link !== socket) return
    socket = undefined
    registered = false
    if (ping) clearInterval(ping)
    ping = undefined
    for (const session of [...sessions.values()]) endSession(session)
    if (code !== undefined) link.close(code)
    else link.terminate()
  }

  function onMessage(link: RelaySocket, text: string, isBinary: boolean): void {
    alive = true
    if (link !== socket) return
    let data: unknown
    try {
      if (isBinary) throw new Error('binary frame')
      data = JSON.parse(text)
    } catch {
      return refuseRelay(link, 'sent a frame that is not JSON')
    }
    if (!registered) {
      const challenge = relayChallengeSchema.safeParse(data)
      if (challenge.success) {
        let message: string
        try {
          const identity = ports.store.identity()
          message = JSON.stringify({
            type: 'register',
            hostKey: identity.publicKey,
            signature: identity.sign(relayRegistrationData(challenge.data.nonce))
          })
        } catch (failure) {
          // The keychain would not give up the key: retrying will not help until it does.
          setStatus('unreachable', failure instanceof Error ? failure.message : String(failure))
          return dropLink(link, 1000)
        }
        link.send(message)
        return
      }
    }
    const parsed = relayToHostSchema.safeParse(data)
    if (!parsed.success) return refuseRelay(link, 'sent a message this host does not understand')
    const message = parsed.data
    if (message.type === 'registered') {
      if (registered) return refuseRelay(link, 'registered this host twice')
      registered = true
      attempts = 0
      ports.log(`Remote access: connected to the relay at ${where}`)
      setStatus('connected')
      return
    }
    if (!registered) return refuseRelay(link, 'sent a session before registering this host')
    if (message.type === 'open') return openSession(message.sessionId)
    if (message.type === 'frame') return frame(message.sessionId, message.frame)
    const session = sessions.get(message.sessionId)
    if (session) endSession(session)
  }

  /** The relay broke its protocol: drop it and dial again, as after any drop. */
  function refuseRelay(link: RelaySocket, why: string): void {
    ports.log(`Remote access: the relay at ${where} ${why}; reconnecting`)
    dialError = `The relay ${why}.`
    dropLink(link, RELAY_CLOSE.BAD_REQUEST)
    closed(RELAY_CLOSE.BAD_REQUEST)
  }

  /** After the link is gone: why, for Settings, and when to try again. */
  function closed(code: number): void {
    if (stopped) return
    if (code === RELAY_CLOSE.REPLACED) {
      ports.log(`Remote access: another process with this computer's key took over the relay`)
      setStatus(
        'replaced',
        "Another Styr using this computer's key (the desktop app or styr serve) connected to the relay, so this one stopped. Turn the relay off in one of them, then on again here."
      )
      return
    }
    if (code === RELAY_CLOSE.NOT_ALLOWED) {
      setStatus(
        'notAllowed',
        "The relay does not allow this computer. On the relay's machine, run styr relay allow with this computer's fingerprint."
      )
    } else if (code === RELAY_CLOSE.UNAUTHORIZED) {
      setStatus('unreachable', "The relay did not accept this computer's signature.")
    } else if (!(throttled && status === 'notAllowed')) {
      // A relay turning this host away for a while after refusing it is still that refusal.
      const why =
        dialError ?? (status === 'connected' ? 'The link to the relay dropped.' : undefined)
      setStatus('unreachable', why ?? `Could not reach the relay at ${where}.`)
    }
    dialError = undefined
    throttled = false
    const delay = Math.min(backoff.maxMs, backoff.firstMs * 2 ** attempts)
    attempts++
    retry = setTimeout(() => {
      retry = undefined
      dial()
    }, delay)
    retry.unref?.()
  }

  function dial(): void {
    if (stopped) return
    alive = true
    let link: RelaySocket | undefined
    const events: RelaySocketEvents = {
      open: () => {
        const current = link
        if (!current || current !== socket) return
        ping = setInterval(() => {
          if (current !== socket) return
          // Removed from another process (the CLI): this process's store has not heard.
          ports.store.reload()
          for (const deviceId of [...byDevice.keys()]) {
            if (!ports.store.hasDevice(deviceId)) client.disconnectDevice(deviceId)
          }
          if (!alive) {
            ports.log(`Remote access: the relay at ${where} stopped answering; reconnecting`)
            dialError = 'The relay stopped answering.'
            // Its close drops the link and dials again.
            return current.terminate()
          }
          alive = false
          current.ping()
        }, ports.pingMs ?? PING_MS)
        ping.unref?.()
      },
      message: (text, isBinary) => {
        if (link) onMessage(link, text, isBinary)
      },
      pong: () => (alive = true),
      close: (code) => {
        if (!link) return
        const current = link === socket
        dropLink(link, undefined)
        if (current) closed(code)
      },
      error: (failure) => {
        const code = (failure as NodeJS.ErrnoException).code
        throttled = (failure as { statusCode?: number }).statusCode === 429
        dialError = throttled
          ? 'The relay is turning this computer away for a minute after refusing it.'
          : code === 'ECONNREFUSED'
            ? `Nothing is listening at ${where}. Is styr relay running there?`
            : `Could not reach the relay at ${where}: ${failure.message}`
      }
    }
    try {
      link = ports.dial(relayUrl(address, port), events)
    } catch (failure) {
      dialError = `Could not reach the relay at ${where}: ${String(failure)}`
      closed(1006)
      return
    }
    socket = link
  }

  const unsubscribe = ports.store.onRevoked((deviceId) => {
    if (byDevice.has(deviceId)) {
      ports.log(`Remote access: ${deviceId} was removed; ending its sessions through the relay`)
    }
    client.disconnectDevice(deviceId, SESSION_CLOSE.REVOKED)
  })

  const client: RelayClient = {
    status: () => status,
    error: () => error,
    connectedDevices: () => [...byDevice.keys()],
    sessions: () => sessions.size,
    disconnectDevice(deviceId, code = SESSION_CLOSE.REVOKED) {
      for (const session of [...(byDevice.get(deviceId) ?? [])]) endSession(session, code)
    },
    async close() {
      if (stopped) return
      stopped = true
      unsubscribe()
      if (retry) clearTimeout(retry)
      retry = undefined
      if (socket) dropLink(socket, 1000)
    }
  }

  dial()
  return client
}
