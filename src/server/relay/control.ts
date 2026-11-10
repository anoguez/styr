import { connect } from 'node:net'
import { join } from 'node:path'
import { configDir } from '@core/config.js'
import { FINGERPRINT } from '@host/remoteAccess/relayProtocol.js'
import { RpcPeer } from '@host/rpc/jsonRpc.js'
import type { LineServer } from '../socket.js'
import type { AllowList } from './allowList.js'
import type { RelayCommand } from './cli.js'
import type { Relay } from './relay.js'

/** What a running relay answers on its Unix socket. Nothing on the network can call these. */
export const RELAY_CTL = {
  allow: 'relay:allow',
  hosts: 'relay:hosts',
  revoke: 'relay:revoke'
} as const

/** A host on the allow list, as `styr relay hosts` shows it. */
export interface RelayHostRow {
  fingerprint: string
  addedAt: string
  connected: boolean
  sessions: number
}

/** `~/.styr/relay.sock`, or `$STYR_HOME/relay.sock`: apart from `server.sock`, so both can run. */
export function defaultRelaySocketPath(): string {
  return join(configDir(), 'relay.sock')
}

export function defaultAllowListPath(): string {
  return join(configDir(), 'relay.json')
}

function fingerprintParam(params: unknown[]): string {
  const [fingerprint] = params
  if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) {
    throw new Error('Not a host fingerprint.')
  }
  return fingerprint
}

/** The control calls, served on the relay's Unix socket (`socket.ts`'s `listen`). */
export function createRelayControl(allowList: AllowList, relay: Relay): LineServer {
  const peers = new Set<{ close(): void }>()
  const handle = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case RELAY_CTL.allow:
        return allowList.allow(fingerprintParam(params))
      case RELAY_CTL.revoke: {
        const fingerprint = fingerprintParam(params)
        const removed = allowList.revoke(fingerprint)
        relay.disconnectHost(fingerprint)
        return removed
      }
      case RELAY_CTL.hosts: {
        const connected = new Map(relay.hosts().map((host) => [host.fingerprint, host.sessions]))
        return allowList.list().map((host): RelayHostRow => ({
          ...host,
          connected: connected.has(host.fingerprint),
          sessions: connected.get(host.fingerprint) ?? 0
        }))
      }
      default:
        throw new Error(`Unknown method ${method}`)
    }
  }
  return {
    connect(write) {
      const peer = new RpcPeer(write, { request: handle })
      const entry = { close: () => peers.delete(entry) }
      peers.add(entry)
      return { receive: (chunk) => peer.receive(chunk), close: entry.close }
    },
    closeAll: () => peers.clear()
  }
}

function request(socketPath: string, method: string, params: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const peer = new RpcPeer((line) => socket.write(line), {})
    socket.on('data', (chunk) => peer.receive(chunk))
    socket.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        new Error(`no Styr relay is running on ${socketPath} (${error.code ?? error.message})`)
      )
    )
    socket.once('connect', () => {
      peer
        .request(method, params)
        .then(resolve, reject)
        .finally(() => socket.destroy())
    })
  })
}

/** `styr relay allow | hosts | revoke`: talks to the running relay. Resolves with the exit code. */
export async function relayControl(
  command: Extract<RelayCommand, { command: 'allow' | 'hosts' | 'revoke' }>,
  socketPath: string,
  out: NodeJS.WritableStream,
  errors: NodeJS.WritableStream
): Promise<number> {
  try {
    if (command.command === 'allow') {
      const added = await request(socketPath, RELAY_CTL.allow, [command.fingerprint])
      out.write(
        added
          ? `Allowed ${command.fingerprint}; that host can register now.\n`
          : `${command.fingerprint} was already allowed.\n`
      )
    } else if (command.command === 'revoke') {
      const removed = await request(socketPath, RELAY_CTL.revoke, [command.fingerprint])
      out.write(
        removed
          ? `Removed ${command.fingerprint}; its sessions are closed.\n`
          : `${command.fingerprint} was not on the allow list.\n`
      )
      if (!removed) return 1
    } else {
      const hosts = (await request(socketPath, RELAY_CTL.hosts, [])) as RelayHostRow[]
      out.write(
        hosts.length === 0
          ? 'No hosts allowed. Add one with `styr relay allow <fingerprint>`.\n'
          : hosts
              .map(
                (host) =>
                  `${host.fingerprint}  ${
                    host.connected
                      ? `connected, ${host.sessions} session${host.sessions === 1 ? '' : 's'}`
                      : 'offline'
                  }  allowed ${host.addedAt}\n`
              )
              .join('')
      )
    }
    return 0
  } catch (error) {
    errors.write(`styr: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
