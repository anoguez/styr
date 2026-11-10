import { encode } from 'uqr'
import type {
  AccessConfig,
  AccessConfigPatch,
  AccessInterface,
  AccessPairing,
  AccessState,
  RelayConfig,
  RelayStatus
} from '@core/types/access.js'
import type { AccessStore } from './accessStore.js'
import { bindAddressProblem, defaultBindAddress, portProblem } from './addresses.js'
import { createKeepAwake, type KeepAwakePorts } from './keepAwake.js'
import { relayAddressProblem, type RelayClient } from './relayClient.js'

/** What the transport gives back once it listens (`src/server/wsListener.ts`). */
export interface RunningListener {
  address: { address: string; port: number }
  connectedDevices(): string[]
  close(): Promise<void>
}

export interface AccessServicePorts {
  store: AccessStore
  /** Opens the listener. Rejects with the reason it could not (`EADDRINUSE` …). */
  listen(address: string, port: number): Promise<RunningListener>
  interfaces(): AccessInterface[]
  keepAwake: KeepAwakePorts
  /** `access:changed`, to the Settings screen. */
  broadcast(state: AccessState): void
  log(message: string): void
  /**
   * Whether Tailscale's Shields Up is on (`tailscale.ts`); undefined when it cannot tell. Absent on
   * a host with no screen to warn on.
   */
  shieldsUp?(): Promise<boolean | undefined>
  /** Whether any workspace has `remoteAccess` on. Absent: assumed so. */
  workspaceShared?(): boolean
  /**
   * Connects out to a relay (`relayClient.ts`), which reports back through `relayChanged` and
   * `relayConnections`. Absent: the relay setting is ignored.
   */
  relay?(address: string, port: number): RelayClient
}

/**
 * Remote access as the Settings screen drives it: whether the listener is up, the interface and
 * port, pairing and removing devices. The listener is only ever started from a config that passed
 * `bindAddressProblem` and `portProblem`; if it cannot start the setting goes back to off with the
 * reason shown, and the app carries on.
 */
export function createAccessService(ports: AccessServicePorts) {
  const { store } = ports
  let running: RunningListener | undefined
  let error: string | undefined
  let relay: { client: RelayClient; address: string; port: number } | undefined
  /** Why the relay could not be started (a bad address); its own refusals are the client's. */
  let relayProblem: string | undefined
  const counts = { direct: 0, relay: 0 }
  let shieldsUp: boolean | undefined
  let applying: Promise<void> = Promise.resolve()
  const awake = createKeepAwake(ports.keepAwake)

  function state(): AccessState {
    const config = store.config()
    const connected = new Set([
      ...(running?.connectedDevices() ?? []),
      ...(relay?.client.connectedDevices() ?? [])
    ])
    const relayError = relayProblem ?? relay?.client.error()
    return {
      ...config,
      listening: running !== undefined,
      ...(error ? { error } : {}),
      interfaces: ports.interfaces(),
      devices: store
        .devices()
        .map((device) => ({ ...device, connected: connected.has(device.id) })),
      fingerprint: store.identity().fingerprint,
      ...(store.pairing() ? { pairingExpiresAt: store.pairing()!.expiresAt } : {}),
      ...(shieldsUp !== undefined ? { shieldsUp } : {}),
      workspaceShared: ports.workspaceShared?.() ?? true,
      relayStatus: relayStatus(config.relay),
      ...(relayError ? { relayError } : {})
    }
  }

  function relayStatus(config: RelayConfig): RelayStatus {
    if (!config.enabled || relayProblem) return 'off'
    return relay?.client.status() ?? 'connecting'
  }

  /**
   * Asks Tailscale whether Shields Up is on, then tells the screen. Run when Settings opens the
   * section and when access is switched on, never on a timer; the probe is a child process, so
   * nothing waits on it.
   */
  async function checkNetwork(): Promise<AccessState> {
    if (ports.shieldsUp) {
      const next = await ports.shieldsUp().catch(() => undefined)
      if (next && !shieldsUp)
        ports.log('Remote access: Tailscale Shields Up is on; devices cannot connect in')
      shieldsUp = next
    }
    return publish()
  }

  function publish(): AccessState {
    const current = state()
    ports.broadcast(current)
    return current
  }

  store.onChange(() => publish())

  async function stopListener(): Promise<void> {
    const listener = running
    running = undefined
    counts.direct = 0
    awake.connections(counts.relay)
    if (listener) await listener.close()
  }

  async function stopRelay(): Promise<void> {
    const current = relay
    relay = undefined
    counts.relay = 0
    awake.connections(counts.direct)
    if (current) await current.client.close()
  }

  async function stop(): Promise<void> {
    store.cancelPairing()
    await Promise.all([stopListener(), stopRelay()])
  }

  /** Brings the listener in line with the saved config. Serialised, so quick changes apply in order. */
  function apply(): Promise<void> {
    applying = applying.then(reconcile, reconcile)
    return applying
  }

  async function reconcile(): Promise<void> {
    const config = store.config()
    awake.enabled(config.keepAwake)
    const wanted = config.enabled
    await reconcileRelay(config.relay)
    const sameSpot =
      running?.address.address === config.bindAddress && running.address.port === config.port
    if (running && (!wanted || !sameSpot)) await stopListener()
    if (!running && !relay) store.cancelPairing()
    if (!wanted || running) return publishQuietly()
    const problem = bindAddressProblem(config.bindAddress) ?? portProblem(config.port)
    if (problem) return failed(problem)
    try {
      running = await ports.listen(config.bindAddress, config.port)
      error = undefined
      ports.log(`Remote access: listening on ${config.bindAddress}:${config.port}`)
    } catch (failure) {
      return failed(describe(failure, config))
    }
    publishQuietly()
  }

  /** The relay link in line with its config: dialled, moved or dropped. */
  async function reconcileRelay(config: RelayConfig): Promise<void> {
    const wanted = config.enabled && ports.relay !== undefined
    const address = config.address.trim()
    if (relay && (!wanted || relay.address !== address || relay.port !== config.port)) {
      await stopRelay()
    }
    if (!wanted) relayProblem = undefined
    if (!wanted || relay) return
    relayProblem = relayAddressProblem(address) ?? portProblem(config.port)
    if (relayProblem) {
      ports.log(`Remote access: relay: ${relayProblem}`)
      return
    }
    ports.log(`Remote access: connecting to the relay at ${address}:${config.port}`)
    relay = { client: ports.relay!(address, config.port), address, port: config.port }
  }

  function failed(message: string): void {
    error = message
    ports.log(`Remote access: ${message}`)
    // Never left switched on without a listener behind it.
    store.setConfig({ enabled: false })
  }

  function publishQuietly(): void {
    publish()
  }

  return {
    state,

    /** At startup: listens if it was left on. */
    start: (): Promise<void> => apply(),

    async configure(patch: AccessConfigPatch): Promise<AccessState> {
      const next: AccessConfigPatch = {}
      if (patch.relay !== undefined) {
        next.relay = { ...patch.relay }
        if (next.relay.address !== undefined) next.relay.address = next.relay.address.trim()
      }
      if (patch.bindAddress !== undefined) next.bindAddress = patch.bindAddress.trim()
      if (patch.port !== undefined) next.port = patch.port
      if (patch.enabled !== undefined) next.enabled = patch.enabled
      if (patch.keepAwake !== undefined) next.keepAwake = patch.keepAwake
      // Switched on with nothing picked: the Tailscale IPv4 address. Only an empty choice is
      // filled; an address the user picked, IPv6 included, is never swapped for another.
      if (next.enabled && patch.bindAddress === undefined && !store.config().bindAddress) {
        const fallback = defaultBindAddress(ports.interfaces())
        if (fallback) next.bindAddress = fallback
      }
      const { relay: _relay, ...direct } = next
      const merged = { ...store.config(), ...direct }
      if (next.enabled) void checkNetwork()
      if (merged.enabled) {
        const problem = bindAddressProblem(merged.bindAddress) ?? portProblem(merged.port)
        if (problem) {
          error = problem
          store.setConfig({ ...next, enabled: false })
          await apply()
          return publish()
        }
      }
      error = undefined
      store.setConfig(next)
      await apply()
      return state()
    },

    /**
     * The QR for one new device: through the relay (`v=2`, end to end) whenever it has registered
     * this host, otherwise to the listener (`v=1`). Refused while neither can take a device, as
     * nothing could answer the phone.
     */
    pair(): AccessPairing {
      const viaRelay = relay?.client.status() === 'connected' ? relay : undefined
      if (!running && !viaRelay) {
        if (store.config().relay.enabled) {
          throw new Error(
            'Styr is not connected to the relay, so a device cannot pair through it. ' +
              'Check the relay status above, or turn on Allow other devices to connect.'
          )
        }
        throw new Error('Turn on Remote access and pick a network interface first.')
      }
      const offer = store.startPairing()
      const fingerprint = store.identity().fingerprint
      const secret = `&secret=${offer.secret}&exp=${offer.expiresAt}`
      const uri = viaRelay
        ? `styr://pair?v=2&relay=${encodeURIComponent(`${bracketed(viaRelay.address)}:${viaRelay.port}`)}` +
          `&hostfp=${fingerprint}&fp=${fingerprint}${secret}`
        : `styr://pair?v=1&host=${encodeURIComponent(bracketed(running!.address.address))}` +
          `&port=${running!.address.port}&fp=${fingerprint}${secret}`
      return { uri, expiresAt: offer.expiresAt, modules: encode(uri, { ecc: 'M', border: 0 }).data }
    },

    cancelPairing: (): void => store.cancelPairing(),

    checkNetwork,

    /** Something the state is derived from changed elsewhere (a workspace was shared). */
    refresh: (): AccessState => publish(),

    revoke(deviceId: string): AccessState {
      store.revoke(deviceId)
      return state()
    },

    /** The listener reports how many devices are connected. */
    connections(count: number): void {
      counts.direct = count
      awake.connections(counts.direct + counts.relay)
      publish()
    },

    /** The relay client reports how many devices are signed in through it. */
    relayConnections(count: number): void {
      counts.relay = count
      awake.connections(counts.direct + counts.relay)
      publish()
    },

    /** The relay link changed (connected, refused, dropped). */
    relayChanged: (): AccessState => publish(),

    stop,
    dispose: stop
  }
}

export type AccessService = ReturnType<typeof createAccessService>

const bracketed = (address: string): string => (address.includes(':') ? `[${address}]` : address)

function describe(failure: unknown, config: AccessConfig): string {
  const code = (failure as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EADDRINUSE')
    return `Port ${config.port} is already in use on ${config.bindAddress}.`
  if (code === 'EADDRNOTAVAIL')
    return `${config.bindAddress} is not an address of this computer any more.`
  if (code === 'EACCES') return `Not allowed to listen on port ${config.port}.`
  return failure instanceof Error ? failure.message : String(failure)
}
