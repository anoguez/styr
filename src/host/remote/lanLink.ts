import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { WebSocket } from 'ws'
import { addressKind } from '../remoteAccess/addresses.js'
import { createSecureClientHandshake, SecureHandshakeError } from '../remoteAccess/secureClient.js'
import {
  DEVICE_NAME_MAX,
  SECURE_FRAME_MAX_CHARS,
  type SecureFrameChannel
} from '../remoteAccess/secureSession.js'
import type { TransportChild } from './connection.js'

/**
 * The desktop as a device of another Styr on the same network (`docs/architecture/remote-access.md`,
 * "Other computers"): the WebSocket and protocol-2 session a phone uses, offered to
 * `RemoteConnection` as a `TransportChild` in place of `ssh … serve attach`, so routing, reconnects
 * and the read-only board while offline are the ssh remote's. The other computer's gate applies:
 * this desktop sees only the workspaces it shares.
 *
 * The same network only, from this side too: a target must be (or resolve to) a private address,
 * and the socket is opened to the address that was checked, never to a name again.
 */

/** How long a dial and its handshake may take before the attempt counts as failed. */
export const LAN_CONNECT_TIMEOUT_MS = 10_000
/** The largest JSON-RPC message this side accepts from the other computer, as the listener's. */
export const LAN_MAX_MESSAGE_BYTES = 8 * 1024 * 1024

/** Where another Styr listens: an address on this computer's network, and its port. */
export interface LanTarget {
  address: string
  port: number
}

/** What this desktop keeps after pairing with another computer (`lanHosts.ts` stores it). */
export interface LanCredentials extends LanTarget {
  /** SHA-256 of the other computer's identity key, pinned at pairing. */
  fingerprint: string
  /** The id the other computer gave this desktop. */
  deviceId: string
  /** This desktop's Ed25519 key for that computer; never sent. */
  privateKey: KeyObject
}

export type Resolve = (name: string) => Promise<string[]>

const resolveAll: Resolve = async (name) =>
  (await lookup(name, { all: true, verbatim: true })).map((entry) => entry.address)

/**
 * The address to dial for `target`: itself when it is a private address (LAN, VPN, loopback), or
 * the first private address a name resolves to. Anything else is refused before a packet is sent:
 * Styr connects only within the network.
 */
export async function privateAddress(
  target: string,
  resolve: Resolve = resolveAll
): Promise<string> {
  const name = target.trim().replace(/^\[(.*)\]$/, '$1')
  if (!name) throw new Error('Give the other computer’s address.')
  const candidates = isIP(name) ? [name] : await resolve(name).catch(() => [])
  if (candidates.length === 0) throw new Error(`${name} could not be found on the network.`)
  const found = candidates.find((address) => addressKind(address) !== undefined)
  if (!found) {
    throw new Error(
      `${name} is not on this computer's network (${candidates[0]}). Styr connects only to ` +
        'computers on the same network or VPN.'
    )
  }
  return found
}

/** `192.168.1.20`, `192.168.1.20:7878`, `[fd00::1]:7878`, `studio.local`: an address and a port. */
export function parseTarget(text: string, defaultPort = 7878): LanTarget | undefined {
  const value = text.trim()
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(value)
  const plain = /^([^:\s/]+)(?::(\d{1,5}))?$/.exec(value)
  const match = bracketed ?? plain ?? (isIP(value) === 6 ? [value, value] : undefined)
  if (!match?.[1]) return undefined
  const port = match[2] ? Number(match[2]) : defaultPort
  if (!(port >= 1 && port <= 65535)) return undefined
  return { address: match[1], port }
}

const url = (address: string, port: number): string =>
  `ws://${address.includes(':') ? `[${address}]` : address}:${port}/`

function dial(address: string, port: number): WebSocket {
  return new WebSocket(url(address, port), {
    // One protocol-2 record per frame; three bytes per character at most.
    maxPayload: SECURE_FRAME_MAX_CHARS * 3,
    handshakeTimeout: LAN_CONNECT_TIMEOUT_MS,
    perMessageDeflate: false,
    followRedirects: false
  })
}

/** What a close code from the other computer means, in words (`wsListener.ts`, `CLOSE`). */
export function closeReason(code: number, name: string): string {
  switch (code) {
    case 4401:
      return `${name} refused this computer: it may have been removed there, or the request was turned down.`
    case 4403:
      return `${name} removed this computer. Add it again to reconnect.`
    case 4408:
      return `${name} did not finish connecting in time.`
    case 4429:
      return `${name} is busy with another device. Try again in a moment.`
    case 4400:
      return `The connection to ${name} broke (a message failed its check).`
    default:
      return `The connection to ${name} closed (${code}).`
  }
}

/**
 * The transport `RemoteConnection` runs for a paired computer: dial, sign in with this desktop's
 * key against the pinned fingerprint, then carry newline-delimited JSON-RPC as one sealed message
 * per line. What it writes before the session is ready waits; nothing is sent unsealed.
 */
export function lanTransport(
  credentials: LanCredentials,
  label: string,
  resolve: Resolve = resolveAll
): TransportChild {
  const stdout: ((chunk: string) => void)[] = []
  const stderr: ((chunk: string) => void)[] = []
  const exits: ((code: number | null, error?: Error) => void)[] = []
  let socket: WebSocket | undefined
  let channel: SecureFrameChannel | undefined
  let queued = ''
  let ended = false
  let killed = false

  const end = (code: number | null, why?: string): void => {
    if (ended) return
    ended = true
    if (why) for (const listener of stderr) listener(`${why}\n`)
    for (const listener of exits) listener(code)
    try {
      socket?.terminate()
    } catch {
      // Already gone.
    }
  }

  /** Each complete line the router wrote becomes one sealed message. */
  const flush = (): void => {
    if (!channel || !socket || socket.readyState !== socket.OPEN) return
    let newline = queued.indexOf('\n')
    while (newline >= 0) {
      const line = queued.slice(0, newline)
      queued = queued.slice(newline + 1)
      if (line) for (const frame of channel.seal(line)) socket.send(frame)
      newline = queued.indexOf('\n')
    }
  }

  void privateAddress(credentials.address, resolve).then(
    (address) => {
      if (killed) return end(null)
      const client = createSecureClientHandshake({
        pinnedFingerprint: credentials.fingerprint,
        identity: { privateKey: credentials.privateKey, publicKey: '' },
        signIn: { type: 'auth', deviceId: credentials.deviceId },
        maxMessageBytes: LAN_MAX_MESSAGE_BYTES
      })
      const ws = dial(address, credentials.port)
      socket = ws
      const timer = setTimeout(
        () => end(null, `${label} did not answer within ${LAN_CONNECT_TIMEOUT_MS / 1000}s.`),
        LAN_CONNECT_TIMEOUT_MS
      )
      timer.unref?.()
      ws.on('open', () => ws.send(client.start()))
      ws.on('message', (data, isBinary) => {
        if (isBinary) return end(null, `${label} sent something that is not Styr.`)
        const text = data.toString()
        if (channel) {
          let message: string | undefined
          try {
            message = channel.open(text)
          } catch {
            return end(null, `The connection to ${label} broke (a message failed its check).`)
          }
          if (message !== undefined) for (const listener of stdout) listener(`${message}\n`)
          return
        }
        try {
          const step = client.receive(text)
          if (step.kind === 'send') for (const frame of step.frames) ws.send(frame)
          if (step.kind === 'ready') {
            clearTimeout(timer)
            channel = step.channel
            flush()
          }
        } catch (error) {
          const why =
            error instanceof SecureHandshakeError
              ? `${label} is not the computer this one paired with (${error.message}). Nothing was sent to it.`
              : String(error)
          end(null, why)
        }
      })
      ws.on('close', (code) => {
        clearTimeout(timer)
        end(code === 1000 || killed ? 0 : 1, killed ? undefined : closeReason(code, label))
      })
      ws.on('error', (error) => {
        clearTimeout(timer)
        end(
          null,
          `${label} could not be reached at ${address}:${credentials.port} (${error.message}).`
        )
      })
      ws.on('unexpected-response', (_request, response) => {
        clearTimeout(timer)
        end(null, `${label} answered HTTP ${response.statusCode ?? '?'}: it may not be Styr.`)
      })
    },
    (error: unknown) => end(null, error instanceof Error ? error.message : String(error))
  )

  return {
    write(data) {
      if (ended) return
      queued += data
      flush()
    },
    onStdout: (listener) => stdout.push(listener as (chunk: string) => void),
    onStderr: (listener) => stderr.push(listener as (chunk: string) => void),
    onExit: (listener) => exits.push(listener),
    kill() {
      killed = true
      if (!socket) return
      try {
        socket.close(1000)
      } catch {
        // Not open yet: `end` terminates it.
      }
      end(0)
    }
  }
}

/** What pairing by approval leaves this desktop with. */
export interface LanPairing {
  fingerprint: string
  deviceId: string
  /** This desktop's private key for that computer, PKCS8 DER. */
  privateKey: Buffer
}

/**
 * Asks another computer to pair by approval (`secureSession.ts`, `request`): its Add device window
 * must be open. `onCode` gets the six digits to show here while the person there compares them
 * and decides; resolves once allowed, rejects with the reason otherwise. `cancel` hangs up.
 */
export function requestLanPairing(
  target: LanTarget,
  name: string,
  onCode: (code: string) => void,
  resolve: Resolve = resolveAll
): { result: Promise<LanPairing>; cancel(): void } {
  const key = generateKeyPairSync('ed25519')
  let socket: WebSocket | undefined
  let cancelled = false
  const result = privateAddress(target.address, resolve).then(
    (address) =>
      new Promise<LanPairing>((done, fail) => {
        if (cancelled) return fail(new Error('Cancelled.'))
        const client = createSecureClientHandshake({
          identity: {
            privateKey: key.privateKey,
            publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
          },
          signIn: { type: 'request', name: name.slice(0, DEVICE_NAME_MAX) },
          maxMessageBytes: LAN_MAX_MESSAGE_BYTES
        })
        const ws = dial(address, target.port)
        socket = ws
        let fingerprint: string | undefined
        let settled = false
        const finish = (outcome: LanPairing | Error): void => {
          if (settled) return
          settled = true
          try {
            ws.close(1000)
          } catch {
            // Not open.
          }
          if (outcome instanceof Error) fail(outcome)
          else done(outcome)
        }
        ws.on('open', () => ws.send(client.start()))
        ws.on('message', (data) => {
          try {
            const step = client.receive(data.toString())
            if (step.kind === 'send') {
              if (step.approval) {
                fingerprint = step.approval.hostFingerprint
                onCode(step.approval.code)
              }
              for (const frame of step.frames) ws.send(frame)
            }
            if (step.kind === 'ready' && step.deviceId && fingerprint) {
              finish({
                fingerprint,
                deviceId: step.deviceId,
                privateKey: key.privateKey.export({ type: 'pkcs8', format: 'der' })
              })
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
        })
        ws.on('close', (code) =>
          finish(
            new Error(
              cancelled
                ? 'Cancelled.'
                : code === 4401
                  ? `${target.address} did not allow this computer. Open Settings → Connections → Add device there, then try again, and allow it.`
                  : closeReason(code, target.address)
            )
          )
        )
        ws.on('error', (error) =>
          finish(
            new Error(`${target.address}:${target.port} could not be reached (${error.message}).`)
          )
        )
        ws.on('unexpected-response', (_request, response) =>
          finish(
            new Error(
              `${target.address}:${target.port} answered HTTP ${response.statusCode ?? '?'}: is Styr listening there?`
            )
          )
        )
      })
  )
  return {
    result,
    cancel() {
      cancelled = true
      try {
        socket?.close(1000)
      } catch {
        // Not open.
      }
    }
  }
}

/** What a pair link (the QR's `styr://pair?v=2…`, `accessService.ts`) gives a device. */
export interface PairLink {
  /** Every address to try, best first; one port for all. */
  targets: LanTarget[]
  /** SHA-256 of the other computer's identity key: pinned before anything is sent. */
  fingerprint: string
  /** The one-time secret the pairing proof is keyed by; it never travels. */
  secret: string
  /** When the link stops working, ms since the epoch. */
  expiresAt: number
}

/** Whether `text` looks like a pair link rather than an address, for a field that takes both. */
export const isPairLink = (text: string): boolean => /^styr:\/\/pair\b/i.test(text.trim())

/** The longest pair link taken from the system: a real one is a few hundred characters. */
export const PAIR_LINK_MAX = 2048

/**
 * The pair link among a launch's arguments, as Windows and Linux pass a clicked `styr://` link to
 * the app (macOS sends it as an `open-url` event, given here as a one-item list). Anything else,
 * another scheme or an oversized argument, is not one.
 */
export function pairLinkIn(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.length <= PAIR_LINK_MAX && isPairLink(arg))?.trim()
}

/**
 * Reads a pair link, the one Add device's QR carries (and its Copy link button gives). Strict:
 * protocol 2 only, a 64-hex fingerprint, a hex secret, a port and at least one address, or
 * undefined. The addresses are not checked here: `pairWithLink` dials only private ones.
 */
export function parsePairLink(text: string): PairLink | undefined {
  const value = text.trim()
  if (!isPairLink(value)) return undefined
  let params: URLSearchParams
  try {
    params = new URL(value).searchParams
  } catch {
    return undefined
  }
  const fingerprint = params.get('fp') ?? ''
  const secret = params.get('secret') ?? ''
  const port = Number(params.get('port'))
  const expiresAt = Number(params.get('exp'))
  if (params.get('v') !== '2') return undefined
  if (!/^[0-9a-f]{64}$/.test(fingerprint) || !/^[0-9a-f]{16,128}$/.test(secret)) return undefined
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return undefined
  const listed = (params.get('hosts') ?? '').split(',')
  const addresses = [params.get('host') ?? '', ...listed]
    .map((address) => address.trim().replace(/^\[(.*)\]$/, '$1'))
    .filter((address, index, all) => address && all.indexOf(address) === index)
    .slice(0, 16)
  if (addresses.length === 0) return undefined
  return {
    targets: addresses.map((address) => ({ address, port })),
    fingerprint,
    secret,
    expiresAt
  }
}

/** A dial that never reached the other computer: the secret is unspent, so the next address may be tried. */
class Unreached extends Error {}

/**
 * Pairs with a pair link, as a phone does with the QR: the other computer is pinned to the link's
 * fingerprint before a byte about this desktop is sent, and the proof is keyed by the link's
 * secret. Nobody has to answer there and there is no code to compare: whoever holds the link was
 * shown it by the other computer. Each address is tried in turn while none answers; once one
 * does, its answer is final (the attempt spends the secret). Resolves with the address that
 * answered, to sign in at from now on.
 */
export function pairWithLink(
  link: PairLink,
  name: string,
  options: { resolve?: Resolve; now?: () => number } = {}
): { result: Promise<{ target: LanTarget; pairing: LanPairing }>; cancel(): void } {
  const resolve = options.resolve ?? resolveAll
  const now = options.now ?? Date.now
  const key = generateKeyPairSync('ed25519')
  let socket: WebSocket | undefined
  let cancelled = false

  const attempt = (target: LanTarget): Promise<LanPairing> =>
    privateAddress(target.address, resolve).then(
      (address) =>
        new Promise<LanPairing>((done, fail) => {
          if (cancelled) return fail(new Error('Cancelled.'))
          const client = createSecureClientHandshake({
            pinnedFingerprint: link.fingerprint,
            identity: {
              privateKey: key.privateKey,
              publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
            },
            signIn: { type: 'pair', name: name.slice(0, DEVICE_NAME_MAX), secret: link.secret },
            maxMessageBytes: LAN_MAX_MESSAGE_BYTES
          })
          const ws = dial(address, target.port)
          socket = ws
          let opened = false
          let settled = false
          const finish = (outcome: LanPairing | Error): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            try {
              ws.close(1000)
            } catch {
              // Not open.
            }
            if (outcome instanceof Error) fail(outcome)
            else done(outcome)
          }
          const timer = setTimeout(
            () =>
              finish(
                opened
                  ? new Error(`${target.address} did not finish pairing in time.`)
                  : new Unreached(`${target.address} did not answer.`)
              ),
            LAN_CONNECT_TIMEOUT_MS
          )
          timer.unref?.()
          ws.on('open', () => {
            opened = true
            ws.send(client.start())
          })
          ws.on('message', (data, isBinary) => {
            if (isBinary) return finish(new Error(`${target.address} is not Styr.`))
            try {
              const step = client.receive(data.toString())
              if (step.kind === 'send') for (const frame of step.frames) ws.send(frame)
              if (step.kind === 'ready') {
                if (!step.deviceId) return finish(new Error('The other computer did not pair.'))
                finish({
                  fingerprint: link.fingerprint,
                  deviceId: step.deviceId,
                  privateKey: key.privateKey.export({ type: 'pkcs8', format: 'der' })
                })
              }
            } catch (error) {
              finish(
                error instanceof SecureHandshakeError
                  ? new Error(
                      `${target.address} is not the computer that made this link (${error.message}). Nothing was sent to it.`
                    )
                  : error instanceof Error
                    ? error
                    : new Error(String(error))
              )
            }
          })
          ws.on('close', (code) =>
            finish(
              cancelled
                ? new Error('Cancelled.')
                : !opened
                  ? new Unreached(`${target.address} closed the connection.`)
                  : code === 4401
                    ? new Error(
                        'The other computer refused this link: it was already used, it expired, or ' +
                          'its Add device window closed. Make a new code there and copy the link again.'
                      )
                    : new Error(closeReason(code, target.address))
            )
          )
          ws.on('error', (error) =>
            finish(
              opened
                ? new Error(`The connection to ${target.address} failed (${error.message}).`)
                : new Unreached(`${target.address}:${target.port}: ${error.message}`)
            )
          )
          ws.on('unexpected-response', (_request, response) =>
            finish(
              new Unreached(
                `${target.address}:${target.port} answered HTTP ${response.statusCode ?? '?'}`
              )
            )
          )
        }),
      (error: unknown) => {
        // Off this network, or a name that does not resolve: nothing was dialled.
        throw new Unreached(error instanceof Error ? error.message : String(error))
      }
    )

  const result = (async () => {
    if (now() >= link.expiresAt) {
      throw new Error(
        'This link has expired. Make a new code on the other computer and copy it again.'
      )
    }
    const misses: string[] = []
    for (const target of link.targets) {
      if (cancelled) throw new Error('Cancelled.')
      try {
        return { target, pairing: await attempt(target) }
      } catch (error) {
        // An address off this network (`privateAddress`) or one nobody answered at: the next.
        if (!(error instanceof Unreached)) throw error
        misses.push(error.message)
      }
    }
    throw new Error(
      `None of the link's addresses answered (${misses.join('; ')}). This computer must be on the ` +
        'same network as the other one, or on its VPN.'
    )
  })()
  return {
    result,
    cancel() {
      cancelled = true
      try {
        socket?.close(1000)
      } catch {
        // Not open.
      }
    }
  }
}
