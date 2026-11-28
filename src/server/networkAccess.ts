import { join } from 'node:path'
import { configDir } from '@core/config.js'
import { createAccessService, type AccessService } from '@host/remoteAccess/accessService.js'
import {
  createAccessStore,
  type AccessStore,
  type SecretBox
} from '@host/remoteAccess/accessStore.js'
import { reachableAddresses } from '@host/remoteAccess/addresses.js'
import { createNetworkPolicy, type GatePorts } from '@host/remoteAccess/gate.js'
import type { KeepAwakePorts } from '@host/remoteAccess/keepAwake.js'
import type { AccessInterface, AccessState, AccessWorkspace } from '@core/types/access.js'
import type { TerminalOutput } from '@core/types.js'
import type { Hub } from './hub.js'
import { startNetworkListener, type Admit } from './wsListener.js'

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
  /** Tests: the admission rule and the address to listen on (see `NetworkListenerOptions`). */
  admit?: Admit
  host?: string
  /**
   * Devices may ask to pair by approval (the desktop, whose Add device window answers). Off for
   * `styr serve`, which has no one to ask: devices pair with its QR.
   */
  takesRequests?: boolean
  /** Tests: how long a request waits for its answer. */
  approvalMs?: number
  /** Tests: this machine's reachable addresses (`reachableAddresses`). */
  interfaces?: () => AccessInterface[]
  /** Only where a screen can show the answers (the desktop): see `AccessServicePorts`. */
  shieldsUp?(): Promise<boolean | undefined>
  workspaces?(): AccessWorkspace[]
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
    listen: (port) =>
      startNetworkListener(
        {
          hub: options.hub,
          store,
          policy: () => createNetworkPolicy(options.gate),
          log: options.log,
          onConnections: (count) => service.connections(count),
          ...(options.admit ? { admit: options.admit } : {}),
          ...(options.host ? { host: options.host } : {}),
          // A request to pair waits for someone at this screen; a server has no screen.
          ...(options.takesRequests ? { approvals: service.approvals } : {}),
          ...(options.approvalMs ? { approvalMs: options.approvalMs } : {})
        },
        port
      ),
    interfaces: options.interfaces ?? (() => reachableAddresses()),
    keepAwake: options.keepAwake,
    broadcast: options.broadcast,
    log: options.log,
    ...(options.shieldsUp ? { shieldsUp: options.shieldsUp } : {}),
    ...(options.workspaces ? { workspaces: options.workspaces } : {})
  })
  return { service, store }
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
