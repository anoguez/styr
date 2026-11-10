import { join } from 'node:path'
import { WebSocket } from 'ws'
import { configDir } from '@core/config.js'
import { createAccessService, type AccessService } from '@host/remoteAccess/accessService.js'
import {
  createAccessStore,
  type AccessStore,
  type SecretBox
} from '@host/remoteAccess/accessStore.js'
import { allowedInterfaces } from '@host/remoteAccess/addresses.js'
import { createNetworkPolicy, type GatePorts } from '@host/remoteAccess/gate.js'
import type { KeepAwakePorts } from '@host/remoteAccess/keepAwake.js'
import {
  startRelayClient,
  type RelayClientPorts,
  type RelaySocket,
  type RelaySocketEvents
} from '@host/remoteAccess/relayClient.js'
import { RELAY_HOST_MESSAGE_MAX_CHARS } from '@host/remoteAccess/relayProtocol.js'
import type { AccessState } from '@core/types/access.js'
import type { TerminalOutput } from '@core/types.js'
import type { Hub } from './hub.js'
import {
  MAX_BUFFERED_BYTES,
  MAX_FRAME_BYTES,
  rawToString,
  startNetworkListener
} from './wsListener.js'

/** Where remote access keeps its settings, devices and key: `~/.styr/remote-access.json`. */
export function accessStorePath(): string {
  return join(configDir(), 'remote-access.json')
}

export interface NetworkAccessOptions {
  hub: Hub
  gate: GatePorts
  keepAwake: KeepAwakePorts
  broadcast(state: AccessState): void
  log(message: string): void
  store?: AccessStore
  /** The OS keychain for the host's private key (the desktop); without it the key stays 0600. */
  secrets?: () => SecretBox | undefined
  /** Tests: the relay client's timings. */
  relayTimings?: Pick<RelayClientPorts, 'pingMs' | 'handshakeMs' | 'backoff'>
  /** Only where a screen can show the answers (the desktop): see `AccessServicePorts`. */
  shieldsUp?(): Promise<boolean | undefined>
  workspaceShared?(): boolean
}

/**
 * Remote access for one host (the desktop app, or `styr serve --listen`): the settings and device
 * store, the policy that filters what a device sees, and the service that starts and stops the
 * WebSocket listener. Nothing listens until the service is switched on.
 */
export function createNetworkAccess(options: NetworkAccessOptions): {
  service: AccessService
  store: AccessStore
} {
  const store =
    options.store ??
    createAccessStore({ path: accessStorePath(), now: Date.now, secrets: options.secrets })
  const service: AccessService = createAccessService({
    store,
    listen: (address, port) =>
      startNetworkListener(
        {
          hub: options.hub,
          store,
          policy: () => createNetworkPolicy(options.gate),
          log: options.log,
          onConnections: (count) => service.connections(count)
        },
        address,
        port
      ),
    relay: (address, port) =>
      startRelayClient(
        {
          store,
          dial: dialRelay,
          connect: (send) => {
            const connection = options.hub.connect(send, createNetworkPolicy(options.gate))
            return { receive: (text) => connection.receive(text), close: () => connection.close() }
          },
          log: options.log,
          onStatus: () => service.relayChanged(),
          onConnections: (count) => service.relayConnections(count),
          maxMessageBytes: MAX_FRAME_BYTES,
          maxBufferedBytes: MAX_BUFFERED_BYTES,
          ...options.relayTimings
        },
        address,
        port
      ),
    interfaces: () => allowedInterfaces(),
    keepAwake: options.keepAwake,
    broadcast: options.broadcast,
    log: options.log,
    ...(options.shieldsUp ? { shieldsUp: options.shieldsUp } : {}),
    ...(options.workspaceShared ? { workspaceShared: options.workspaceShared } : {})
  })
  return { service, store }
}

/**
 * The relay client's socket, on `ws`. A relay frame is ASCII when the phone behaves, but one a
 * phone made of other characters would be up to three bytes each: the limit is in bytes, and a
 * frame over it would cut the whole link, so it allows for that and the relay's own character
 * limit holds the rest.
 */
export function dialRelay(url: string, events: RelaySocketEvents): RelaySocket {
  const ws = new WebSocket(url, {
    maxPayload: RELAY_HOST_MESSAGE_MAX_CHARS * 3,
    handshakeTimeout: 10_000,
    perMessageDeflate: false,
    followRedirects: false
  })
  ws.on('open', () => events.open())
  ws.on('message', (data, isBinary) => events.message(rawToString(data), isBinary))
  ws.on('pong', () => events.pong())
  ws.on('close', (code, reason) => events.close(code, reason.toString()))
  ws.on('error', (error) => events.error(error))
  // An HTTP answer instead of an upgrade (a 429, a 404): the socket closes after it.
  ws.on('unexpected-response', (_request, response) => {
    events.error(
      Object.assign(new Error(`the relay answered HTTP ${response.statusCode ?? '?'}`), {
        statusCode: response.statusCode
      })
    )
    ws.terminate()
  })
  return {
    get bufferedAmount() {
      return ws.bufferedAmount
    },
    send: (text) => ws.send(text),
    ping: () => ws.ping(),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate()
  }
}

/** Broadcasts after which what network clients may hold has to be checked again. */
const REVALIDATE = new Set(['settings:changed', 'workspaces:changed'])

/**
 * Hands one of the host's broadcasts to the hub: terminal output only to its attached clients,
 * everything else to all of them (each filtered by its policy). A change to the settings or the
 * workspaces also re-checks which terminals a device still holds.
 */
export function forwardToHub(hub: Hub, channel: string, payload?: unknown): void {
  if (channel === 'terminal:data') {
    const { id, ...output } = payload as { id: string } & TerminalOutput
    hub.terminalData(id, output)
    return
  }
  hub.broadcast(channel, payload)
  if (channel === 'terminal:exit') hub.terminalExited((payload as { id: string }).id)
  if (REVALIDATE.has(channel)) hub.refresh()
}
