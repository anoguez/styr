import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  addressKind,
  admitConnection,
  inSubnet,
  isPrivateAddress,
  normalizeAddress,
  portProblem,
  proxyHeader,
  reachableAddresses
} from './addresses.js'

const v4 = (address: string, cidr: string | null = null): NetworkInterfaceInfo => ({
  address,
  family: 'IPv4',
  internal: address.startsWith('127.'),
  netmask: '',
  mac: '',
  cidr
})
const v6 = (address: string, cidr: string | null = null): NetworkInterfaceInfo => ({
  address,
  family: 'IPv6',
  internal: address === '::1',
  netmask: '',
  mac: '',
  cidr,
  scopeid: 0
})

/** A laptop on a home Wi-Fi, on Tailscale, with Docker, and an ISP's CGNAT address on Ethernet. */
const LAPTOP = {
  lo0: [v4('127.0.0.1', '127.0.0.1/8'), v6('::1', '::1/128')],
  en0: [
    v4('192.168.1.20', '192.168.1.20/24'),
    v6('fe80::1c', 'fe80::1c/64'),
    v6('fd12:3456::20', 'fd12:3456::20/64')
  ],
  en5: [v4('100.70.3.4', '100.70.0.0/16')],
  utun3: [v4('100.90.1.1', '100.90.1.1/32'), v6('fd7a:115c:a1e0::1', 'fd7a:115c:a1e0::1/128')],
  docker0: [v4('172.17.0.1', '172.17.0.1/16')]
}

describe('addressKind', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['10.0.0.5', 'lan'],
    ['172.16.0.1', 'lan'],
    ['172.31.255.255', 'lan'],
    ['192.168.1.20', 'lan'],
    ['169.254.10.1', 'lan'],
    ['fe80::1', 'lan'],
    ['fe80::1%en0', 'lan'],
    ['fd00::1', 'lan'],
    ['fc00::1', 'lan'],
    ['::ffff:192.168.1.5', 'lan'],
    ['100.64.0.1', 'tailscale'],
    ['100.127.255.254', 'tailscale'],
    ['fd7a:115c:a1e0::1', 'tailscale'],
    ['fd7a:115c:a1e0:ab12:4843:cd96:6200:1', 'tailscale'],
    ['::ffff:100.64.0.9', 'tailscale']
  ])('%s is %s', (address, kind) => {
    expect(addressKind(address)).toBe(kind)
  })

  it.each([
    '8.8.8.8',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '192.169.0.1',
    '11.0.0.1',
    '2001:4860:4860::8888',
    '2a00:1450::1',
    'fec0::1',
    '::ffff:8.8.8.8',
    '0.0.0.0',
    '::',
    'example.com',
    '',
    '999.1.1.1'
  ])('%s is not private', (address) => {
    expect(addressKind(address)).toBeUndefined()
    expect(isPrivateAddress(address)).toBe(false)
  })

  it('treats a missing address as not private', () => {
    expect(isPrivateAddress(undefined)).toBe(false)
  })
})

describe('normalizeAddress', () => {
  it('reads an IPv4 peer on a dual-stack socket as IPv4 and drops a zone', () => {
    expect(normalizeAddress('::ffff:192.168.1.5')).toBe('192.168.1.5')
    expect(normalizeAddress('fe80::1%en0')).toBe('fe80::1')
    expect(normalizeAddress('10.0.0.1')).toBe('10.0.0.1')
  })
})

describe('inSubnet', () => {
  it('matches IPv4 and IPv6 prefixes, never across families', () => {
    expect(inSubnet('192.168.1.77', '192.168.1.20/24')).toBe(true)
    expect(inSubnet('192.168.2.77', '192.168.1.20/24')).toBe(false)
    expect(inSubnet('::ffff:192.168.1.77', '192.168.1.20/24')).toBe(true)
    expect(inSubnet('fd12:3456::99', 'fd12:3456::20/64')).toBe(true)
    expect(inSubnet('fd12:3457::99', 'fd12:3456::20/64')).toBe(false)
    expect(inSubnet('192.168.1.77', 'fd12:3456::20/64')).toBe(false)
    expect(inSubnet('192.168.1.77', null)).toBe(false)
    expect(inSubnet('192.168.1.77', '192.168.1.20/99')).toBe(false)
  })
})

describe('admitConnection', () => {
  const admit = (local: string, remote: string) => admitConnection(local, remote, LAPTOP)

  it('admits a device on the same Wi-Fi', () => {
    expect(admit('192.168.1.20', '192.168.1.77')).toBeUndefined()
    expect(admit('::ffff:192.168.1.20', '::ffff:192.168.1.77')).toBeUndefined()
    expect(admit('fd12:3456::20', 'fd12:3456::abc')).toBeUndefined()
    expect(admit('fe80::1c%en0', 'fe80::99%en0')).toBeUndefined()
  })

  it('admits a device on the VPN', () => {
    expect(admit('100.90.1.1', '100.101.2.3')).toBeUndefined()
    expect(admit('fd7a:115c:a1e0::1', 'fd7a:115c:a1e0::77')).toBeUndefined()
  })

  it('admits loopback to loopback only (an ssh tunnel)', () => {
    expect(admit('127.0.0.1', '127.0.0.1')).toBeUndefined()
    expect(admit('::1', '::1')).toBeUndefined()
    expect(admit('127.0.0.1', '192.168.1.77')).toMatch(/loopback/)
    expect(admit('192.168.1.20', '127.0.0.1')).toMatch(/loopback/)
  })

  it('refuses the internet, whichever end is public', () => {
    expect(admit('192.168.1.20', '8.8.8.8')).toMatch(/not a private address/)
    expect(admit('192.168.1.20', '2a00:1450::1')).toMatch(/not a private address/)
    expect(admit('203.0.113.5', '192.168.1.77')).toMatch(/arrived on 203\.0\.113\.5/)
    expect(admit('', '')).toBeDefined()
  })

  it('refuses a private address from another network routed in', () => {
    // A port-forward or a router between subnets: private, but not this network.
    expect(admit('192.168.1.20', '192.168.7.5')).toMatch(/not on en0's network/)
    expect(admit('192.168.1.20', '10.0.0.8')).toMatch(/not on en0's network/)
    expect(admit('192.168.1.20', '100.101.2.3')).toMatch(/not on en0's network/)
  })

  it("refuses an internet provider's shared network on a network card", () => {
    expect(admit('100.70.3.4', '100.70.9.9')).toMatch(/internet provider/)
  })

  it('refuses an address this computer does not have (it left that network)', () => {
    expect(admit('192.168.50.2', '192.168.50.3')).toMatch(/not an address of this computer/)
  })

  it('refuses a peer on the Wi-Fi that aims at the VPN address', () => {
    // Most systems take a packet for any of their addresses on any interface.
    expect(admit('100.90.1.1', '192.168.1.77')).toMatch(/not on Tailscale/)
    expect(admit('fd7a:115c:a1e0::1', 'fd12:3456::abc')).toMatch(/not on Tailscale/)
    const wireguard = {
      en0: [v4('192.168.1.20', '192.168.1.20/24')],
      wg0: [v4('10.8.0.2', '10.8.0.2/32')]
    }
    expect(admitConnection('10.8.0.2', '192.168.1.77', wireguard)).toMatch(/en0's network/)
    expect(admitConnection('10.8.0.2', '10.8.0.9', wireguard)).toBeUndefined()
  })

  it('names Windows, WireGuard and ZeroTier tunnels as VPNs', () => {
    const vpn = {
      Tailscale: [v4('100.90.1.2', '100.90.1.2/32')],
      wg0: [v4('10.8.0.2', '10.8.0.2/32')],
      'WireGuard Tunnel': [v4('10.9.0.2', '10.9.0.2/32')],
      ztabcdef: [v4('10.147.17.2', '10.147.17.2/32')]
    }
    expect(admitConnection('100.90.1.2', '100.90.5.5', vpn)).toBeUndefined()
    expect(admitConnection('10.8.0.2', '10.8.0.9', vpn)).toBeUndefined()
    expect(admitConnection('10.9.0.2', '10.9.0.9', vpn)).toBeUndefined()
    expect(admitConnection('10.147.17.2', '10.147.17.9', vpn)).toBeUndefined()
    // A tunnel still refuses a public peer.
    expect(admitConnection('10.8.0.2', '8.8.8.8', vpn)).toMatch(/not a private address/)
  })
})

describe('reachableAddresses', () => {
  it('lists the Wi-Fi first, then the VPN, then virtual machines; never loopback or link-local', () => {
    expect(reachableAddresses(LAPTOP).map((entry) => `${entry.name} ${entry.address}`)).toEqual([
      'en0 192.168.1.20',
      'en0 fd12:3456::20',
      'utun3 100.90.1.1',
      'utun3 fd7a:115c:a1e0::1',
      'docker0 172.17.0.1'
    ])
  })

  it("never offers an internet provider's shared network or a public address", () => {
    expect(
      reachableAddresses({
        en0: [v4('100.70.3.4', '100.70.0.0/16'), v4('203.0.113.5', '203.0.113.0/24')],
        eth1: [v4('169.254.3.3', '169.254.0.0/16')]
      })
    ).toEqual([])
  })

  it('names the kind of each address', () => {
    expect(
      reachableAddresses(LAPTOP)
        .slice(0, 3)
        .map((entry) => entry.kind)
    ).toEqual(['lan', 'lan', 'tailscale'])
  })
})

describe('portProblem', () => {
  it('allows unprivileged ports only', () => {
    expect(portProblem(7777)).toBeUndefined()
    expect(portProblem(80)).toBeDefined()
    expect(portProblem(70000)).toBeDefined()
    expect(portProblem(1.5)).toBeDefined()
  })
})

describe('proxyHeader', () => {
  it('finds a forwarding header', () => {
    expect(proxyHeader({ 'x-forwarded-for': '1.2.3.4' })).toBe('x-forwarded-for')
    expect(proxyHeader({ forwarded: 'for=1.2.3.4' })).toBe('forwarded')
    expect(proxyHeader({ host: 'a' })).toBeUndefined()
  })
})
