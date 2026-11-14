/** Which private range an address is in (`host/remoteAccess/addresses.ts`). */
export type AddressKind = 'loopback' | 'tailscale'

/** Remote access settings are not part of `Settings`: see `docs/architecture/remote-access.md`. */
export interface AccessConfig {
  /** Whether the desktop app listens at all. Off until the user switches it on. */
  enabled: boolean
  /** The one private address to listen on; empty until the user picks one. */
  bindAddress: string
  port: number
  /** Hold the Mac awake while a device is connected. */
  keepAwake: boolean
  /** Connect out to a `styr relay` too, for devices that cannot connect in. */
  relay: RelayConfig
}

/** Where the relay is: a loopback or Tailscale address only, as for the listener. */
export interface RelayConfig {
  enabled: boolean
  /** The relay's address; empty until the user types one. */
  address: string
  port: number
}

/** What `styr relay`'s answer means for Settings: the line under "Connect through a relay". */
export type RelayStatus =
  | 'off'
  | 'connecting'
  | 'connected'
  /** Could not reach it, or the link dropped; trying again with backoff. */
  | 'unreachable'
  /** The relay does not have this computer's fingerprint on its allow list (or revoked it). */
  | 'notAllowed'
  /** Another process with this computer's key registered on the relay; this one stopped. */
  | 'replaced'

/** A change to the config: any of its keys, and any of the relay's. */
export type AccessConfigPatch = Partial<Omit<AccessConfig, 'relay'>> & {
  relay?: Partial<RelayConfig>
}

/** A paired device as Settings lists it: never the verifier. */
export interface AccessDevice {
  id: string
  name: string
  createdAt: string
  lastSeenAt?: string
  /** Connected right now. */
  connected: boolean
}

export interface AccessInterface {
  name: string
  address: string
  kind: AddressKind
}

/** What Settings → Remote access shows. */
export interface AccessState extends AccessConfig {
  /** The listener is up, on `bindAddress:port`. */
  listening: boolean
  /** Why it is not, when it was asked to be (the port is taken, the interface is gone …). */
  error?: string
  interfaces: AccessInterface[]
  devices: AccessDevice[]
  /**
   * This install's key fingerprint, which a phone pins when it pairs. Absent until remote access is
   * first turned on: the key is made then, never just to show this.
   */
  fingerprint?: string
  /** An open pairing offer: when it stops working. The secret is only in the QR. */
  pairingExpiresAt?: number
  /**
   * Tailscale's Shields Up is on, so devices cannot connect in. Undefined until checked, or when
   * Tailscale's CLI could not be asked.
   */
  shieldsUp?: boolean
  /** Some workspace has `remoteAccess` on, so a paired device has something to open. */
  workspaceShared: boolean
  /** The link to the relay, when `relay.enabled`. */
  relayStatus: RelayStatus
  /** Why the relay is not connected, in words (a bad address, the refusal it gave). */
  relayError?: string
}

/** The QR to scan: the text it encodes and its modules, dark ones true. */
export interface AccessPairing {
  uri: string
  expiresAt: number
  modules: boolean[][]
}
