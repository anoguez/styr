import { isIPv4, isIPv6 } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { AccessInterface, AddressKind } from '@core/types/access.js'

export type { AddressKind }

/**
 * Remote access is for devices on the same network as this computer, and nothing else: the same
 * home or office network, or a VPN both are on (Tailscale, WireGuard …). Never the internet.
 *
 * The listener takes connections on every interface, so it follows the computer from one network
 * to the next without being set up again, and `admitConnection` decides, for every socket before
 * a byte of it is read, whether the peer is on one of this computer's networks:
 *
 * - on a network card (Wi-Fi, Ethernet) the peer must be inside that interface's own subnet, so a
 *   router cannot route the internet, or another network, in;
 * - on a VPN's tunnel interface the peer must have a private address that is not on one of this
 *   computer's network cards' subnets (a LAN peer aiming at the VPN address), and on Tailscale's
 *   address it must be a Tailscale address;
 * - on loopback (an ssh tunnel) the peer must be loopback too;
 * - a public address on either end is refused, and so is the carrier-grade NAT range on a network
 *   card (that is an internet provider's network, shared with its other customers).
 *
 * It is enforced here, in code, so a port-forward or a wrong route cannot let the internet in.
 * Being on the network is not being let in: every session is end-to-end encrypted and a device
 * still has to be paired (`secureSession.ts`).
 */

/** The Tailscale prefix of IPv6 addresses (`fd7a:115c:a1e0::/48`). */
const TAILSCALE_V6 = (0xfd7an << 112n) | (0x115cn << 96n) | (0xa1e0n << 80n)

function parseIPv4(address: string): number | undefined {
  if (!isIPv4(address)) return undefined
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0)
}

/** An IPv6 address as a 128-bit number, or undefined. A zone (`%en0`) is ignored. */
function parseIPv6(input: string): bigint | undefined {
  const address = input.split('%')[0] ?? ''
  if (!isIPv6(address)) return undefined
  let text = address
  const tail = text.lastIndexOf(':')
  const embedded = text.slice(tail + 1)
  if (embedded.includes('.')) {
    const v4 = parseIPv4(embedded)
    if (v4 === undefined) return undefined
    text = `${text.slice(0, tail + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const [head = '', rest] = text.split('::')
  const left = head ? head.split(':') : []
  const right = rest === undefined ? [] : rest ? rest.split(':') : []
  const missing = 8 - left.length - right.length
  if (rest === undefined ? missing !== 0 : missing < 1) return undefined
  const groups = [...left, ...Array<string>(rest === undefined ? 0 : missing).fill('0'), ...right]
  if (groups.length !== 8) return undefined
  return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n)
}

function inV4(value: number, base: string, bits: number): boolean {
  const prefix = parseIPv4(base)!
  const shift = 32 - bits
  return Math.floor(value / 2 ** shift) === Math.floor(prefix / 2 ** shift)
}

/**
 * An address as the listener compares it: an IPv4 address that reached a dual-stack socket as
 * `::ffff:a.b.c.d` is that IPv4 address, and an IPv6 zone (`%en0`) is dropped.
 */
export function normalizeAddress(address: string): string {
  const bare = address.split('%')[0] ?? ''
  const v6 = parseIPv6(bare)
  if (v6 !== undefined && v6 >> 32n === 0xffffn) {
    return [24, 16, 8, 0].map((s) => Number((v6 >> BigInt(s)) & 0xffn)).join('.')
  }
  return bare
}

/** What kind of private address `address` is, or undefined for a public one or a non-address. */
export function addressKind(input: string): AddressKind | undefined {
  const address = normalizeAddress(input)
  const v4 = parseIPv4(address)
  if (v4 !== undefined) {
    if (inV4(v4, '127.0.0.0', 8)) return 'loopback'
    if (inV4(v4, '10.0.0.0', 8) || inV4(v4, '172.16.0.0', 12) || inV4(v4, '192.168.0.0', 16)) {
      return 'lan'
    }
    if (inV4(v4, '169.254.0.0', 16)) return 'lan'
    if (inV4(v4, '100.64.0.0', 10)) return 'tailscale'
    return undefined
  }
  const v6 = parseIPv6(address)
  if (v6 === undefined) return undefined
  if (v6 === 1n) return 'loopback'
  if (v6 >> 80n === TAILSCALE_V6 >> 80n) return 'tailscale'
  // fc00::/7, unique local; fe80::/10, link-local.
  if (v6 >> 121n === 0x7en || v6 >> 118n === 0x3fan) return 'lan'
  return undefined
}

export function isPrivateAddress(address: string | undefined): boolean {
  return address !== undefined && addressKind(address) !== undefined
}

export function portProblem(port: number): string | undefined {
  return Number.isInteger(port) && port >= 1024 && port <= 65535
    ? undefined
    : 'The port must be a whole number from 1024 to 65535.'
}

/**
 * A VPN's tunnel interface: `utun*` (macOS), `tailscale0` / `tun*` / `wg*` (Linux), ZeroTier's
 * `zt*`, and the names Windows gives Tailscale, WireGuard and ZeroTier adapters. A tunnel's peers
 * are not in its own subnet (Tailscale gives each machine a /32), so they are checked by range.
 */
const TUNNEL_INTERFACE = /^(utun|tun|wg|zt)\w*$|tailscale|wireguard|zerotier/i

/**
 * Interfaces a phone cannot reach this computer through: containers and virtual machines on this
 * computer. Their peers are admitted like any network's, but their addresses are listed last.
 */
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|vboxnet|vmnet|vethernet|lxc|lxd|cni|podman)/i

type Interfaces = ReturnType<typeof networkInterfaces>

/** Whether `address` is inside `cidr` (`192.168.1.5/24`, `fd00::1/64`). */
export function inSubnet(address: string, cidr: string | null | undefined): boolean {
  if (!cidr) return false
  const [base = '', bitsText = ''] = cidr.split('/')
  const bits = Number(bitsText)
  const a4 = parseIPv4(normalizeAddress(address))
  const b4 = parseIPv4(base)
  if (a4 !== undefined && b4 !== undefined) {
    if (!(bits >= 0 && bits <= 32)) return false
    const shift = 32 - bits
    return Math.floor(a4 / 2 ** shift) === Math.floor(b4 / 2 ** shift)
  }
  const a6 = parseIPv6(normalizeAddress(address))
  const b6 = parseIPv6(base)
  if (a6 === undefined || b6 === undefined || a4 !== undefined || b4 !== undefined) return false
  if (!(bits >= 0 && bits <= 128)) return false
  const shift = BigInt(128 - bits)
  return a6 >> shift === b6 >> shift
}

/**
 * Whether a connection from `remote` that arrived on this computer's `local` address may be read
 * at all: undefined when it may, else the reason it may not (for the log). See the top of this
 * file for the rules.
 */
export function admitConnection(
  local: string | undefined,
  remote: string | undefined,
  interfaces: Interfaces = networkInterfaces()
): string | undefined {
  const source = normalizeAddress(remote ?? '')
  const target = normalizeAddress(local ?? '')
  const sourceKind = addressKind(source)
  const targetKind = addressKind(target)
  if (!sourceKind) return `${source || '?'} is not a private address`
  if (!targetKind) return `it arrived on ${target || '?'}, which is not a private address`
  if (targetKind === 'loopback' || sourceKind === 'loopback') {
    return targetKind === sourceKind ? undefined : 'loopback only talks to loopback'
  }
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (normalizeAddress(entry.address) !== target) continue
      if (TUNNEL_INTERFACE.test(name))
        return tunnelPeerProblem(source, sourceKind, targetKind, interfaces)
      if (targetKind === 'tailscale') {
        return `${target} is on ${name}, not a VPN: it looks like an internet provider's shared network`
      }
      if (inSubnet(source, entry.cidr)) return undefined
      return `${source} is not on ${name}'s network (${entry.cidr ?? '?'})`
    }
  }
  return `it arrived on ${target}, which is not an address of this computer`
}

/**
 * Why a peer may not use this computer's VPN address, or undefined. Most systems take a packet for
 * any of their addresses on any interface, so someone on the Wi-Fi can aim at the VPN address
 * directly: a source inside a network card's subnet is such a peer, never a VPN one. On Tailscale's
 * address the peer must be on Tailscale too.
 */
function tunnelPeerProblem(
  source: string,
  sourceKind: AddressKind,
  targetKind: AddressKind,
  interfaces: Interfaces
): string | undefined {
  if (targetKind === 'tailscale' && sourceKind !== 'tailscale') {
    return `${source} is not on Tailscale, but asked for this computer's Tailscale address`
  }
  for (const [name, entries] of Object.entries(interfaces)) {
    if (TUNNEL_INTERFACE.test(name)) continue
    for (const entry of entries ?? []) {
      if (inSubnet(source, entry.cidr)) {
        return `${source} is on ${name}'s network but asked for this computer's VPN address`
      }
    }
  }
  return undefined
}

/** Network cards before VPNs before virtual machines; IPv4 before IPv6 within each. */
function rank(choice: AccessInterface): number {
  const where = VIRTUAL_INTERFACE.test(choice.name) ? 4 : TUNNEL_INTERFACE.test(choice.name) ? 2 : 0
  return where + (isIPv4(choice.address) ? 0 : 1)
}

/**
 * Where a device on one of this computer's networks can reach it, best first: what Settings shows
 * and the pairing QR carries. Leaves out loopback, link-local addresses (no DHCP, or an IPv6
 * address that needs a zone) and the carrier-grade NAT range on a network card, which
 * `admitConnection` would refuse.
 */
export function reachableAddresses(
  interfaces: Interfaces = networkInterfaces()
): AccessInterface[] {
  const choices: AccessInterface[] = []
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      const kind = addressKind(entry.address)
      if (!kind || kind === 'loopback') continue
      if (/^(169\.254\.|fe[89ab])/i.test(entry.address)) continue
      if (kind === 'tailscale' && !TUNNEL_INTERFACE.test(name)) continue
      choices.push({ name, address: entry.address, kind })
    }
  }
  return choices.sort((a, b) => rank(a) - rank(b))
}

/** A request header that says a proxy sits in front, which the listener refuses. */
const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
  'via'
]

export function proxyHeader(headers: Record<string, unknown>): string | undefined {
  return PROXY_HEADERS.find((name) => headers[name] !== undefined)
}
