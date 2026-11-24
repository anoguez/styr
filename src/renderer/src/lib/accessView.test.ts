import { describe, expect, it } from 'vitest'
import type { AccessState } from '@core/types.js'
import {
  canPair,
  deviceLine,
  groupedFingerprint,
  interfaceLabel,
  listenerStatus,
  needsSharedWorkspace,
  qrPath,
  showShieldsUpWarning
} from './accessView.js'

const base: AccessState = {
  enabled: false,
  port: 7878,
  keepAwake: false,
  listening: false,
  interfaces: [
    { name: 'en0', address: '192.168.1.20', kind: 'lan' },
    { name: 'utun4', address: '100.101.102.103', kind: 'tailscale' }
  ],
  devices: [],
  fingerprint: 'ab'.repeat(32),
  workspaceShared: true
}

describe('interfaceLabel', () => {
  it('says where each address is', () => {
    expect(base.interfaces.map(interfaceLabel)).toEqual([
      '192.168.1.20 · en0 · local network',
      '100.101.102.103 · utun4 · VPN'
    ])
  })

  it('marks an IPv6 address as such', () => {
    expect(interfaceLabel({ name: 'utun4', address: 'fd7a:115c:a1e0::1', kind: 'tailscale' })).toBe(
      'fd7a:115c:a1e0::1 · utun4 · VPN IPv6'
    )
  })
})

describe('needsSharedWorkspace', () => {
  const device = { id: 'd1', name: 'iPhone', createdAt: '2026-11-01T00:00:00Z', connected: true }

  it('asks once a device is paired and nothing is shared', () => {
    expect(needsSharedWorkspace({ devices: [device], workspaceShared: false })).toBe(true)
  })

  it('stays quiet with no device or with a shared workspace', () => {
    expect(needsSharedWorkspace({ devices: [], workspaceShared: false })).toBe(false)
    expect(needsSharedWorkspace({ devices: [device], workspaceShared: true })).toBe(false)
  })
})

describe('qrPath', () => {
  it('draws runs of dark modules inside a quiet zone', () => {
    const { path, size } = qrPath([
      [true, true, false],
      [false, true, false]
    ])
    expect(size).toBe(2 + 8)
    expect(path).toBe('M4 4h2v1h-2zM5 5h1v1h-1z')
  })

  it('draws nothing for an empty code', () => {
    expect(qrPath([])).toEqual({ path: '', size: 8 })
  })
})

describe('deviceLine', () => {
  const now = Date.parse('2026-10-24T12:00:00Z')
  const device = { id: 'a', name: 'iPhone', createdAt: '2026-10-22T12:00:00Z', connected: false }

  it('says when it was last seen and paired', () => {
    expect(deviceLine({ ...device, lastSeenAt: '2026-10-24T11:30:00Z' }, now)).toBe(
      'Last seen 30 min ago · paired 2 d ago'
    )
  })

  it('says connected, and never connected', () => {
    expect(deviceLine({ ...device, connected: true }, now)).toMatch(/^Connected/)
    expect(deviceLine(device, now)).toMatch(/^Never connected/)
  })
})

describe('groupedFingerprint', () => {
  it('shows the first eight groups', () => {
    expect(groupedFingerprint('abcdefgh'.repeat(8))).toBe('abcd efgh abcd efgh abcd efgh abcd efgh')
  })
})

describe('listenerStatus', () => {
  it('says who can connect, or that nothing is open', () => {
    expect(listenerStatus({ ...base, enabled: true, listening: true })).toMatch(
      /^On\. Devices on the same network/
    )
    expect(listenerStatus({ ...base, enabled: true, listening: true, interfaces: [] })).toMatch(
      /no network a device could reach/
    )
    expect(listenerStatus(base)).toMatch(/No port is open/)
  })
})

describe('canPair', () => {
  it('pairs only while listening on a network', () => {
    expect(canPair(base)).toBe(false)
    expect(canPair({ ...base, listening: true })).toBe(true)
    expect(canPair({ ...base, listening: true, interfaces: [] })).toBe(false)
  })
})

describe('showShieldsUpWarning', () => {
  it('warns about Shields Up only while devices may connect', () => {
    expect(showShieldsUpWarning({ ...base, enabled: true, shieldsUp: true })).toBe(true)
    expect(showShieldsUpWarning({ ...base, enabled: false, shieldsUp: true })).toBe(false)
    expect(showShieldsUpWarning({ ...base, enabled: true, shieldsUp: false })).toBe(false)
  })
})
