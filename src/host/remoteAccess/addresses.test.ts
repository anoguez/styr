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
    ['100.64.0.1', 'tailscale'],
    ['100.127.255.254', 'tailscale'],
    ['fd7a:115c:a1e0::1', 'tailscale'],
    ['fd7a:115c:a1e0:ab12:4843:cd96:6200:1', 'tailscale'],
    ['::ffff:100.64.0.9', 'tailscale'],
    ['::ffff:127.0.0.1', 'loopback']
  ])('%s is %s', (address, kind) => {
    expect(addressKind(address)).toBe(kind)
  })

  it.each([
    '10.0.0.5',
    '172.16.0.1',
    '192.168.1.20',
    '169.254.10.1',
    'fe80::1',
    '::ffff:192.168.1.5',
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
  ])('%s is not allowed', (address) => {
    expect(addressKind(address)).toBeUndefined()
    expect(isPrivateAddress(address)).toBe(false)
  })

  it('treats a missing address as not allowed', () => {
    expect(isPrivateAddress(undefined)).toBe(false)
  })
})

describe('bindAddressProblem', () => {
  it('accepts loopback and Tailscale addresses', () => {
    for (const address of ['127.0.0.1', '100.100.1.1', '::1', 'fd7a:115c:a1e0::5']) {
      expect(bindAddressProblem(address)).toBeUndefined()
    }
  })

  it('refuses every interface, public addresses, names and nothing', () => {
    expect(bindAddressProblem('0.0.0.0')).toMatch(/every interface/)
    expect(bindAddressProblem('::')).toMatch(/every interface/)
    expect(bindAddressProblem('8.8.8.8')).toMatch(/Tailscale or loopback/)
    expect(bindAddressProblem('192.168.1.5')).toMatch(/Tailscale or loopback/)
    expect(bindAddressProblem('10.0.0.2')).toMatch(/Tailscale or loopback/)
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
  it('lists only Tailscale and loopback addresses', () => {
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
    ).toEqual([{ name: 'utun3', address: '100.90.1.1', kind: 'tailscale' }])
  })
})

describe('proxyHeader', () => {
  it('finds a forwarding header', () => {
    expect(proxyHeader({ 'x-forwarded-for': '1.2.3.4' })).toBe('x-forwarded-for')
    expect(proxyHeader({ forwarded: 'for=1.2.3.4' })).toBe('forwarded')
    expect(proxyHeader({ host: 'a' })).toBeUndefined()
  })
})
