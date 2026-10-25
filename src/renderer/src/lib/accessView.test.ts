import { describe, expect, it } from 'vitest'
import type { AccessState } from '@core/types.js'
import {
  deviceLine,
  groupedFingerprint,
  interfaceOptions,
  listenerStatus,
  qrPath
} from './accessView.js'

const base: AccessState = {
  enabled: false,
  bindAddress: '',
  port: 7878,
  keepAwake: false,
  listening: false,
  interfaces: [
    { name: 'lo0', address: '127.0.0.1', kind: 'loopback' },
    { name: 'utun4', address: '100.101.102.103', kind: 'tailscale' }
  ],
  devices: [],
  fingerprint: 'ab'.repeat(32)
}

describe('interfaceOptions', () => {
  it('lists each private address with where it is', () => {
    expect(interfaceOptions(base)).toEqual([
      { value: '127.0.0.1', label: '127.0.0.1 · lo0 · this computer only' },
      { value: '100.101.102.103', label: '100.101.102.103 · utun4 · Tailscale' }
    ])
  })

  it('keeps a saved address whose interface is gone, marked', () => {
    const options = interfaceOptions({ ...base, bindAddress: '10.9.9.9' })
    expect(options.at(-1)).toEqual({ value: '10.9.9.9', label: '10.9.9.9 · not available now' })
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
  it('says what it listens on, or why it does not', () => {
    expect(listenerStatus({ ...base, bindAddress: '127.0.0.1', listening: true })).toMatch(
      /^Listening on 127\.0\.0\.1:7878/
    )
    expect(listenerStatus(base)).toMatch(/Pick a network interface/)
    expect(listenerStatus({ ...base, bindAddress: '127.0.0.1' })).toMatch(/No port is open/)
  })
})
