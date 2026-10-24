/** Which private range an address is in (`host/remoteAccess/addresses.ts`). */
export type AddressKind = 'loopback' | 'private' | 'link-local' | 'tailscale'

/** Remote access settings are not part of `Settings`: see `docs/architecture/remote-access.md`. */
export interface AccessConfig {
  /** Whether the desktop app listens at all. Off until the user switches it on. */
  enabled: boolean
  /** The one private address to listen on; empty until the user picks one. */
  bindAddress: string
  port: number
  /** Hold the Mac awake while a device is connected. */
  keepAwake: boolean
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
  /** This install's key fingerprint, which a phone pins when it pairs. */
  fingerprint: string
  /** An open pairing offer: when it stops working. The secret is only in the QR. */
  pairingExpiresAt?: number
}

/** The QR to scan: the text it encodes and its modules, dark ones true. */
export interface AccessPairing {
  uri: string
  expiresAt: number
  modules: boolean[][]
}
