import { encode } from 'uqr'
import type {
  AccessConfig,
  AccessInterface,
  AccessPairing,
  AccessState
} from '@core/types/access.js'
import type { AccessStore } from './accessStore.js'
import { bindAddressProblem, portProblem } from './addresses.js'
import { createKeepAwake, type KeepAwakePorts } from './keepAwake.js'

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
  let applying: Promise<void> = Promise.resolve()
  const awake = createKeepAwake(ports.keepAwake)

  function state(): AccessState {
    const config = store.config()
    const connected = new Set(running?.connectedDevices() ?? [])
    return {
      ...config,
      listening: running !== undefined,
      ...(error ? { error } : {}),
      interfaces: ports.interfaces(),
      devices: store
        .devices()
        .map((device) => ({ ...device, connected: connected.has(device.id) })),
      fingerprint: store.identity().fingerprint,
      ...(store.pairing() ? { pairingExpiresAt: store.pairing()!.expiresAt } : {})
    }
  }

  function publish(): AccessState {
    const current = state()
    ports.broadcast(current)
    return current
  }

  store.onChange(() => publish())

  async function stop(): Promise<void> {
    const listener = running
    running = undefined
    store.cancelPairing()
    awake.connections(0)
    if (listener) await listener.close()
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
    const sameSpot =
      running?.address.address === config.bindAddress && running.address.port === config.port
    if (running && (!wanted || !sameSpot)) await stop()
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

    async configure(patch: Partial<AccessConfig>): Promise<AccessState> {
      const next: Partial<AccessConfig> = {}
      if (patch.bindAddress !== undefined) next.bindAddress = patch.bindAddress.trim()
      if (patch.port !== undefined) next.port = patch.port
      if (patch.enabled !== undefined) next.enabled = patch.enabled
      if (patch.keepAwake !== undefined) next.keepAwake = patch.keepAwake
      const merged = { ...store.config(), ...next }
      if (merged.enabled) {
        const problem = bindAddressProblem(merged.bindAddress) ?? portProblem(merged.port)
        if (problem) {
          error = problem
          store.setConfig({ ...next, enabled: false })
          return publish()
        }
      }
      error = undefined
      store.setConfig(next)
      await apply()
      return state()
    },

    /** The QR for one new device. Refused while nothing is listening. */
    pair(): AccessPairing {
      if (!running) throw new Error('Turn on Remote access and pick a network interface first.')
      const offer = store.startPairing()
      const { address, port } = running.address
      const host = address.includes(':') ? `[${address}]` : address
      const uri =
        `styr://pair?v=1&host=${encodeURIComponent(host)}&port=${port}` +
        `&fp=${store.identity().fingerprint}&secret=${offer.secret}&exp=${offer.expiresAt}`
      return { uri, expiresAt: offer.expiresAt, modules: encode(uri, { ecc: 'M', border: 0 }).data }
    },

    cancelPairing: (): void => store.cancelPairing(),

    revoke(deviceId: string): AccessState {
      store.revoke(deviceId)
      return state()
    },

    /** The transport reports how many devices are connected. */
    connections(count: number): void {
      awake.connections(count)
      publish()
    },

    stop,
    dispose: stop
  }
}

export type AccessService = ReturnType<typeof createAccessService>

function describe(failure: unknown, config: AccessConfig): string {
  const code = (failure as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EADDRINUSE')
    return `Port ${config.port} is already in use on ${config.bindAddress}.`
  if (code === 'EADDRNOTAVAIL')
    return `${config.bindAddress} is not an address of this computer any more.`
  if (code === 'EACCES') return `Not allowed to listen on port ${config.port}.`
  return failure instanceof Error ? failure.message : String(failure)
}
