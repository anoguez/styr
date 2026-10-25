import { join } from 'node:path'
import { configDir } from '@core/config.js'
import { createAccessService, type AccessService } from '@host/remoteAccess/accessService.js'
import { createAccessStore, type AccessStore } from '@host/remoteAccess/accessStore.js'
import { allowedInterfaces } from '@host/remoteAccess/addresses.js'
import { createNetworkPolicy, type GatePorts } from '@host/remoteAccess/gate.js'
import type { KeepAwakePorts } from '@host/remoteAccess/keepAwake.js'
import type { AccessState } from '@core/types/access.js'
import type { TerminalOutput } from '@core/types.js'
import { PROTOCOL_VERSION, type Hub } from './hub.js'
import { startNetworkListener } from './wsListener.js'

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
  const store = options.store ?? createAccessStore({ path: accessStorePath(), now: Date.now })
  const service: AccessService = createAccessService({
    store,
    listen: (address, port) =>
      startNetworkListener(
        {
          hub: options.hub,
          store,
          policy: () => createNetworkPolicy(options.gate),
          protocol: PROTOCOL_VERSION,
          log: options.log,
          onConnections: (count) => service.connections(count)
        },
        address,
        port
      ),
    interfaces: () => allowedInterfaces(),
    keepAwake: options.keepAwake,
    broadcast: options.broadcast,
    log: options.log
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
