import { isIPv4, isIPv6 } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { AddressKind } from '@core/types/access.js'

export type { AddressKind }

/**
 * Network access is for private networks only: the listener binds to, and accepts connections
 * from, loopback, RFC 1918 and link-local addresses and Tailscale's ranges, never a public one.
 * It is enforced here, in code, so a port-forward or a wrong route cannot let the internet in.
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

/** What kind of private address `address` is, or undefined for a public one or a non-address. */
export function addressKind(address: string): AddressKind | undefined {
  const v4 = parseIPv4(address)
  if (v4 !== undefined) {
    if (inV4(v4, '127.0.0.0', 8)) return 'loopback'
    if (inV4(v4, '10.0.0.0', 8) || inV4(v4, '172.16.0.0', 12) || inV4(v4, '192.168.0.0', 16)) {
      return 'private'
    }
    if (inV4(v4, '169.254.0.0', 16)) return 'link-local'
    if (inV4(v4, '100.64.0.0', 10)) return 'tailscale'
    return undefined
  }
  const v6 = parseIPv6(address)
  if (v6 === undefined) return undefined
  if (v6 === 1n) return 'loopback'
  // ::ffff:a.b.c.d is an IPv4 address on a dual-stack socket.
  if (v6 >> 32n === 0xffffn)
    return addressKind([24, 16, 8, 0].map((s) => Number((v6 >> BigInt(s)) & 0xffn)).join('.'))
  if (v6 >> 118n === 0x3fan) return 'link-local'
  if (v6 >> 80n === TAILSCALE_V6 >> 80n) return 'tailscale'
  return undefined
}

export function isPrivateAddress(address: string | undefined): boolean {
  return address !== undefined && addressKind(address) !== undefined
}

/** Why `address` cannot be listened on, or undefined when it can. */
export function bindAddressProblem(address: string): string | undefined {
  const trimmed = address.trim()
  if (!trimmed) return 'Pick a network interface to listen on.'
  if (trimmed === '0.0.0.0' || trimmed === '::' || /^(::)?0*$/.test(trimmed)) {
    return 'Listening on every interface is not allowed. Pick one private address.'
  }
  if (!isIPv4(trimmed) && !isIPv6(trimmed)) return `${trimmed} is not an IP address.`
  if (!isPrivateAddress(trimmed)) {
    return `${trimmed} is a public address. Only loopback, private (10.x, 172.16–31.x, 192.168.x), link-local and Tailscale addresses are allowed.`
  }
  return undefined
}

export function portProblem(port: number): string | undefined {
  return Number.isInteger(port) && port >= 1024 && port <= 65535
    ? undefined
    : 'The port must be a whole number from 1024 to 65535.'
}

export interface InterfaceChoice {
  name: string
  address: string
  kind: AddressKind
}

/** The addresses this computer has that the listener may use. */
export function allowedInterfaces(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()
): InterfaceChoice[] {
  const choices: InterfaceChoice[] = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const entry of addresses ?? []) {
      const kind = addressKind(entry.address)
      if (kind) choices.push({ name, address: entry.address, kind })
    }
  }
  return choices
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
