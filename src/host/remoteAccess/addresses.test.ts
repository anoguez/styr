import { describe, expect, it } from 'vitest'
import {
  addressKind,
  allowedInterfaces,
  bindAddressProblem,
  isPrivateAddress,
  portProblem,
  proxyHeader
} from './addresses.js'

describe('addressKind', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['::1', 'loopback'],
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.20', 'private'],
    ['169.254.10.1', 'link-local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%en0', 'link-local'],
    ['100.64.0.1', 'tailscale'],
    ['100.127.255.254', 'tailscale'],
    ['fd7a:115c:a1e0::1', 'tailscale'],
    ['fd7a:115c:a1e0:ab12:4843:cd96:6200:1', 'tailscale'],
    ['::ffff:192.168.1.5', 'private'],
    ['::ffff:c0a8:0105', 'private'],
    ['::ffff:127.0.0.1', 'loopback']
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
    'fd7b:115c:a1e0::1',
    'fd00::1',
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

describe('bindAddressProblem', () => {
  it('accepts loopback, private and Tailscale addresses', () => {
    for (const address of ['127.0.0.1', '192.168.1.5', '100.100.1.1', '::1', 'fd7a:115c:a1e0::5']) {
      expect(bindAddressProblem(address)).toBeUndefined()
    }
  })

  it('refuses every interface, public addresses, names and nothing', () => {
    expect(bindAddressProblem('0.0.0.0')).toMatch(/every interface/)
    expect(bindAddressProblem('::')).toMatch(/every interface/)
    expect(bindAddressProblem('8.8.8.8')).toMatch(/public/)
    expect(bindAddressProblem('localhost')).toMatch(/not an IP/)
    expect(bindAddressProblem('')).toMatch(/Pick/)
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

describe('allowedInterfaces', () => {
  it('lists only private addresses', () => {
    const entry = (address: string) => ({
      address,
      family: 'IPv4' as const,
      internal: false,
      netmask: '',
      mac: '',
      cidr: null
    })
    expect(
      allowedInterfaces({
        en0: [entry('192.168.1.2'), entry('8.8.4.4')],
        utun3: [entry('100.90.1.1')]
      })
    ).toEqual([
      { name: 'en0', address: '192.168.1.2', kind: 'private' },
      { name: 'utun3', address: '100.90.1.1', kind: 'tailscale' }
    ])
  })
})

describe('proxyHeader', () => {
  it('finds a forwarding header', () => {
    expect(proxyHeader({ 'x-forwarded-for': '1.2.3.4' })).toBe('x-forwarded-for')
    expect(proxyHeader({ forwarded: 'for=1.2.3.4' })).toBe('forwarded')
    expect(proxyHeader({ host: 'a' })).toBeUndefined()
  })
})
