import { randomUUID } from 'node:crypto'
import { encode } from 'uqr'
import type {
  AccessConfigPatch,
  AccessInterface,
  AccessPairing,
  AccessRequest,
  AccessState,
  AccessWorkspace
} from '@core/types/access.js'
import type { AccessStore } from './accessStore.js'
import { portProblem } from './addresses.js'
import { createKeepAwake, type KeepAwakePorts } from './keepAwake.js'

/** A device asking to pair by approval, as the listener hands it over. */
export type ApprovalQuestion = Omit<AccessRequest, 'id'>

/**
 * Who answers a device's request to pair (this service, for the listener). `ask` returns undefined
 * when it cannot take the question now (another is waiting, or no Add device window is open), and
 * the device is turned away; otherwise the listener calls `withdraw` if the device leaves or its
 * time runs out first.
 */
export interface ApprovalPort {
  ask(
    question: ApprovalQuestion,
    answer: (allow: boolean) => void
  ): { withdraw(): void } | undefined
}

/** What the transport gives back once it listens (`src/server/wsListener.ts`). */
export interface RunningListener {
  address: { address: string; port: number }
  connectedDevices(): string[]
  close(): Promise<void>
}

export interface AccessServicePorts {
  store: AccessStore
  /**
   * Opens the listener on every interface (`admitConnection` keeps it to this computer's
   * networks). Rejects with the reason it could not (`EADDRINUSE` …).
   */
  listen(port: number): Promise<RunningListener>
  /** Where devices on this computer's networks reach it, best first (`reachableAddresses`). */
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
  /**
   * This computer's own workspaces and whether each is shared. Absent (`styr serve`, which has no
   * screen): none listed, and a workspace is assumed shared.
   */
  workspaces?(): AccessWorkspace[]
}

/**
 * How many ports after the saved one are tried when it is taken. The one found is saved, so a
 * paired device finds the computer on the same port next time.
 */
export const PORT_ATTEMPTS = 10

/**
 * Remote access as the Settings screen drives it: one switch, then pairing and removing devices.
 * Devices reach this computer from the networks it is on (`addresses.ts`); there is nothing to
 * pick. If the listener cannot start the setting goes back to off with the reason shown, and the
 * app carries on.
 */
export function createAccessService(ports: AccessServicePorts) {
  const { store } = ports
  let running: RunningListener | undefined
  let error: string | undefined
  let shieldsUp: boolean | undefined
  let applying: Promise<void> = Promise.resolve()
  /** The one request to pair that waits for an answer, with how to give it. */
  let pending: (AccessRequest & { answer(allow: boolean): void }) | undefined
  const awake = createKeepAwake(ports.keepAwake)

  function state(): AccessState {
    const config = store.config()
    // Read, never made here: this runs at startup, before any window is up (see `reconcile`).
    const fingerprint = store.fingerprint()
    const connected = new Set(running?.connectedDevices() ?? [])
    const workspaces = ports.workspaces?.() ?? []
    return {
      ...config,
      ...(running ? { port: running.address.port } : {}),
      listening: running !== undefined,
      ...(error ? { error } : {}),
      interfaces: ports.interfaces(),
      devices: store
        .devices()
        .map((device) => ({ ...device, connected: connected.has(device.id) })),
      ...(fingerprint !== undefined ? { fingerprint } : {}),
      ...(store.pairing() ? { pairingExpiresAt: store.pairing()!.expiresAt } : {}),
      ...(shieldsUp !== undefined ? { shieldsUp } : {}),
      workspaces,
      workspaceShared: ports.workspaces ? workspaces.some((entry) => entry.shared) : true,
      ...(pending
        ? {
            request: {
              id: pending.id,
              name: pending.name,
              code: pending.code,
              source: pending.source
            }
          }
        : {})
    }
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
        ports.log('Remote access: Tailscale Shields Up is on; devices cannot connect in over it')
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

  /** Turns down the waiting request, if any: its window closed, or access went off. */
  function declinePending(): void {
    const waiting = pending
    pending = undefined
    waiting?.answer(false)
  }

  const approvals: ApprovalPort = {
    ask(question, answer) {
      if (pending || !store.pairing()) return undefined
      const id = randomUUID()
      pending = { ...question, id, answer }
      publish()
      return {
        withdraw() {
          if (pending?.id !== id) return
          pending = undefined
          publish()
        }
      }
    }
  }

  async function stop(): Promise<void> {
    declinePending()
    store.cancelPairing()
    const listener = running
    running = undefined
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
    if (running && !config.enabled) await stop()
    if (!config.enabled || running) return void publish()
    const problem = portProblem(config.port)
    if (problem) return failed(problem)
    let lastFailure: unknown
    for (let offset = 0; offset < PORT_ATTEMPTS && !running; offset++) {
      const port = config.port + offset
      if (port > 65535) break
      try {
        running = await ports.listen(port)
      } catch (failure) {
        lastFailure = failure
        // Only a taken port moves on to the next; anything else will not be better there.
        if ((failure as NodeJS.ErrnoException | undefined)?.code !== 'EADDRINUSE') break
      }
    }
    if (!running) return failed(describe(lastFailure, config.port))
    error = undefined
    const port = running.address.port
    if (port !== config.port) {
      ports.log(`Remote access: port ${config.port} is taken; using ${port}`)
      store.setConfig({ port })
    }
    ports.log(`Remote access: devices on this computer's networks can connect on port ${port}`)
    // The key is made (and sealed) once access is on, so Settings can show its fingerprint. Left on
    // from before, it already exists and only its public half is read.
    try {
      store.identity()
    } catch {
      // The keychain would not seal it: pairing or the first sign-in tries again.
    }
    publish()
  }

  function failed(message: string): void {
    error = message
    ports.log(`Remote access: ${message}`)
    // Never left switched on without a listener behind it.
    store.setConfig({ enabled: false })
  }

  return {
    state,

    /** At startup: listens if it was left on. */
    start: (): Promise<void> => apply(),

    async configure(patch: AccessConfigPatch): Promise<AccessState> {
      const next: AccessConfigPatch = {}
      if (patch.enabled !== undefined) next.enabled = patch.enabled
      if (patch.keepAwake !== undefined) next.keepAwake = patch.keepAwake
      if (patch.port !== undefined) {
        const problem = portProblem(patch.port)
        if (problem) throw new Error(problem)
        next.port = patch.port
        // A new port takes effect on the next start of the listener.
        if (running && patch.port !== running.address.port) await stop()
      }
      if (next.enabled) void checkNetwork()
      error = undefined
      store.setConfig(next)
      await apply()
      return state()
    },

    /**
     * The QR for one new device (`v=2`, protocol 2). `host` is the address a device on the same
     * Wi-Fi reaches first; `hosts` lists every address it may try, best first (a device on the
     * computer's VPN needs that one). Refused while nothing listens, as nothing could answer.
     */
    pair(): AccessPairing {
      if (!running) throw new Error('Turn on Allow devices on your network to connect first.')
      const addresses = ports.interfaces().map((entry) => entry.address)
      if (addresses.length === 0) {
        throw new Error(
          'This computer is not on a network a device could reach it on. Connect it to Wi-Fi, ' +
            'Ethernet or a VPN first.'
        )
      }
      const offer = store.startPairing()
      const fingerprint = store.identity().fingerprint
      const hosts = addresses.map(bracketed)
      const uri =
        `styr://pair?v=2&host=${encodeURIComponent(hosts[0]!)}&port=${running.address.port}` +
        `&hosts=${encodeURIComponent(hosts.join(','))}&fp=${fingerprint}` +
        `&secret=${offer.secret}&exp=${offer.expiresAt}`
      return { uri, expiresAt: offer.expiresAt, modules: encode(uri, { ecc: 'M', border: 0 }).data }
    },

    /** The Add device window closed: its QR stops working and a waiting request is turned down. */
    cancelPairing(): void {
      declinePending()
      store.cancelPairing()
    },

    approvals,

    /**
     * The person's answer to the waiting request. Throws when `requestId` is not the one waiting
     * (it was withdrawn, or already answered), so a stale click allows nothing.
     */
    answer(requestId: string, allow: boolean): AccessState {
      if (!pending || pending.id !== requestId) {
        throw new Error('That device is no longer waiting. Ask it to try again.')
      }
      const waiting = pending
      pending = undefined
      waiting.answer(allow)
      return publish()
    },

    checkNetwork,

    /** Something the state is derived from changed elsewhere (a workspace was shared). */
    refresh: (): AccessState => publish(),

    revoke(deviceId: string): AccessState {
      store.revoke(deviceId)
      return state()
    },

    /** The listener reports how many devices are connected. */
    connections(count: number): void {
      awake.connections(count)
      publish()
    },

    stop,
    dispose: stop
  }
}

export type AccessService = ReturnType<typeof createAccessService>

const bracketed = (address: string): string => (address.includes(':') ? `[${address}]` : address)

function describe(failure: unknown, port: number): string {
  const code = (failure as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EADDRINUSE') {
    return `Ports ${port} to ${port + PORT_ATTEMPTS - 1} are all in use by other programs.`
  }
  if (code === 'EACCES') return `Not allowed to listen on port ${port}.`
  return failure instanceof Error ? failure.message : String(failure)
}
