/**
 * Which private network an address is on (`host/remoteAccess/addresses.ts`). `lan` is a home or
 * office network (RFC 1918, link-local, IPv6 unique local); `tailscale` is Tailscale's range, also
 * used by other VPNs and, on a network card, by internet providers (carrier-grade NAT).
 */
export type AddressKind = 'loopback' | 'lan' | 'tailscale'

/** Remote access settings are not part of `Settings`: see `docs/architecture/remote-access.md`. */
export interface AccessConfig {
  /** Whether this computer accepts devices at all. Off until the user switches it on. */
  enabled: boolean
  /**
   * The port devices connect to. Not shown in Settings: it moves to the next free one when it is
   * taken, and the pairing QR carries it.
   */
  port: number
  /** Hold the computer awake while a device is connected. */
  keepAwake: boolean
}

/** A change to the config: any of its keys. */
export type AccessConfigPatch = Partial<AccessConfig>

/** A paired device as Settings lists it: never the verifier. */
export interface AccessDevice {
  id: string
  name: string
  createdAt: string
  lastSeenAt?: string
  /** Connected right now. */
  connected: boolean
}

/** A workspace of this computer, as Settings → Connections lists it for sharing. */
export interface AccessWorkspace {
  id: string
  name: string
  /** `remoteAccess` is on: paired devices may open it. */
  shared: boolean
}

/** One address of this computer a device on the same network can reach it at. */
export interface AccessInterface {
  name: string
  address: string
  kind: AddressKind
}

/** What Settings → Connections shows. */
export interface AccessState extends AccessConfig {
  /** Devices can connect now: the listener is up, on `port`. */
  listening: boolean
  /** Why it is not, when it was asked to be (no port free, the system refused …). */
  error?: string
  /** Where a device on one of this computer's networks reaches it, best first. */
  interfaces: AccessInterface[]
  devices: AccessDevice[]
  /**
   * This install's key fingerprint, which a device pins when it pairs. Absent until remote access is
   * first turned on: the key is made then, never just to show this.
   */
  fingerprint?: string
  /** An open pairing offer: when it stops working. The secret is only in the QR. */
  pairingExpiresAt?: number
  /**
   * Tailscale's Shields Up is on, so devices cannot connect in over Tailscale. Undefined until
   * checked, or when Tailscale's CLI could not be asked.
   */
  shieldsUp?: boolean
  /**
   * This computer's own workspaces (never an ssh remote's stub) and whether each is shared. Empty
   * where nothing can show them (`styr serve`).
   */
  workspaces: AccessWorkspace[]
  /** Some workspace has `remoteAccess` on, so a paired device has something to open. */
  workspaceShared: boolean
  /** A device asking to pair, while the Add device window is open. */
  request?: AccessRequest
}

/** A device asking to pair by approval, waiting for the person at this computer to answer. */
export interface AccessRequest {
  id: string
  /** The name the device gives itself: its own words, at most 100 characters. */
  name: string
  /** Six digits the device shows too; they must match before the request is allowed. */
  code: string
  /** The address it connects from. */
  source: string
}

/** The QR to scan: the text it encodes and its modules, dark ones true. */
export interface AccessPairing {
  uri: string
  expiresAt: number
  modules: boolean[][]
}
