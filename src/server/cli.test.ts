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
})
