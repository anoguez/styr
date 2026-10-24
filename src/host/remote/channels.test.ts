import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WRITE_CHANNELS, channelRoute } from './channels.js'

describe('the routing tables', () => {
  it('routes every channel the server answers somewhere other than locally', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../channelTable.ts', import.meta.url)),
      'utf8'
    )
    const server = [...source.matchAll(/^\s+'([a-z]+:[A-Za-z]+)': channel\(/gm)].map((m) => m[1]!)
    expect(server.length).toBeGreaterThan(60)
    // `terminal:write` is one-way (`send`); every invoke channel must reach a server.
    const unrouted = server.filter((c) => c !== 'terminal:write' && channelRoute(c) === 'local')
    expect(unrouted).toEqual([])
  })

  it('only refuses writes the router actually routes to a server', () => {
    const unrouted = [...WRITE_CHANNELS].filter((c) => channelRoute(c) === 'local')
    expect(unrouted).toEqual([])
  })
})
