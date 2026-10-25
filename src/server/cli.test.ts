import { describe, expect, it } from 'vitest'
import { parseServerArgs } from './cli.js'

describe('parseServerArgs', () => {
  it('serves by default, with or without the leading serve', () => {
    expect(parseServerArgs([])).toEqual({ command: 'serve' })
    expect(parseServerArgs(['serve'])).toEqual({ command: 'serve' })
  })

  it('attaches, on the default socket or a given one', () => {
    expect(parseServerArgs(['serve', 'attach'])).toEqual({ command: 'attach' })
    expect(parseServerArgs(['attach', '--socket', '/tmp/s.sock'])).toEqual({
      command: 'attach',
      socket: '/tmp/s.sock'
    })
    expect(parseServerArgs(['serve', '--socket=/tmp/s.sock'])).toEqual({
      command: 'serve',
      socket: '/tmp/s.sock'
    })
  })

  it('prints the version or the usage', () => {
    expect(parseServerArgs(['serve', '--version'])).toEqual({ command: 'version' })
    expect(parseServerArgs(['-h'])).toEqual({ command: 'help' })
  })

  it('refuses what it does not know, and a --socket without a path', () => {
    expect(parseServerArgs(['serve', 'stop'])).toEqual({
      command: 'invalid',
      message: 'Unknown argument: stop'
    })
    expect(parseServerArgs(['serve', '--socket'])).toEqual({
      command: 'invalid',
      message: '--socket needs a path'
    })
    // `attach` is a subcommand, not an argument that may come later.
    expect(parseServerArgs(['serve', '--socket', '/s', 'attach']).command).toBe('invalid')
  })

  it('listens on one address and pairs, with a default port', () => {
    expect(parseServerArgs(['serve', '--listen', '100.64.0.3'])).toEqual({
      command: 'serve',
      listen: { address: '100.64.0.3', port: 7878 }
    })
    expect(parseServerArgs(['serve', '--listen=192.168.1.5:9000', '--pair'])).toEqual({
      command: 'serve',
      listen: { address: '192.168.1.5', port: 9000 },
      pair: true
    })
    expect(parseServerArgs(['serve', '--listen', '[fd7a:115c:a1e0::1]:7000'])).toEqual({
      command: 'serve',
      listen: { address: 'fd7a:115c:a1e0::1', port: 7000 }
    })
    expect(parseServerArgs(['serve', '--listen', 'fd7a:115c:a1e0::1'])).toEqual({
      command: 'serve',
      listen: { address: 'fd7a:115c:a1e0::1', port: 7878 }
    })
  })

  it('refuses --listen without an address, --pair without --listen, and attach with either', () => {
    expect(parseServerArgs(['serve', '--listen']).command).toBe('invalid')
    expect(parseServerArgs(['serve', '--pair'])).toEqual({
      command: 'invalid',
      message: '--pair needs --listen'
    })
    expect(parseServerArgs(['attach', '--listen', '127.0.0.1']).command).toBe('invalid')
  })

  it('controls a running server: pair, devices, revoke', () => {
    expect(parseServerArgs(['serve', 'pair'])).toEqual({ command: 'pair' })
    expect(parseServerArgs(['devices', '--socket', '/s'])).toEqual({
      command: 'devices',
      socket: '/s'
    })
    expect(parseServerArgs(['serve', 'revoke', 'abc123'])).toEqual({
      command: 'revoke',
      id: 'abc123'
    })
    expect(parseServerArgs(['serve', 'revoke']).command).toBe('invalid')
    expect(parseServerArgs(['serve', 'pair', '--listen', '127.0.0.1']).command).toBe('invalid')
  })
})
