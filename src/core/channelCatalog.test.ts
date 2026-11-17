import { describe, expect, it } from 'vitest'
import { CHANNEL_SPECS } from './channelCatalog.js'

const where = (test: (spec: (typeof CHANNEL_SPECS)[number][1]) => unknown) =>
  CHANNEL_SPECS.filter(([, spec]) => test(spec)).map(([channel]) => channel)

describe('the channel catalog', () => {
  it('routes every write to a server, never leaving it local', () => {
    expect(where((s) => s.write && s.route === 'local')).toEqual([])
  })

  it('sends one-way calls only to the session they name, and never as writes', () => {
    expect(where((s) => s.send && s.route !== 'session')).toEqual([])
    expect(where((s) => s.send && (s.write || s.snapshot || s.offline || s.sessionResult))).toEqual(
      []
    )
  })

  it('gives an offline default only to a read that keeps a snapshot', () => {
    expect(where((s) => s.offline && s.write)).toEqual([])
    expect(where((s) => s.offline && !s.snapshot)).toEqual([])
  })

  it('keeps snapshots only for reads', () => {
    expect(where((s) => s.snapshot && s.write)).toEqual([])
  })

  it('tags new sessions only on calls a server answers', () => {
    expect(where((s) => s.sessionResult && !['active', 'session'].includes(s.route))).toEqual([])
  })

  it('names each channel as a domain:call pair', () => {
    expect(where(() => true).filter((c) => !/^[a-z]+:[A-Za-z]+$/.test(c))).toEqual([])
  })
})
