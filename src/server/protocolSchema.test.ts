import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from './hub.js'
import { buildProtocolSchema } from './protocolSchema.js'

const FILE = fileURLToPath(new URL('../../docs/protocol/styr-remote.schema.json', import.meta.url))
const text = `${JSON.stringify(buildProtocolSchema(), null, 2)}\n`

describe('the published protocol schema', () => {
  it('is up to date (run with UPDATE_PROTOCOL_SCHEMA=1 to rewrite it)', () => {
    if (process.env.UPDATE_PROTOCOL_SCHEMA === '1') {
      mkdirSync(dirname(FILE), { recursive: true })
      writeFileSync(FILE, text)
    }
    expect(readFileSync(FILE, 'utf8')).toBe(text)
  })

  it('carries the protocol version and the channels a client calls', () => {
    const schema = JSON.parse(text) as {
      protocol: number
      channels: Record<string, { kind: string; params: unknown }>
    }
    expect(schema.protocol).toBe(PROTOCOL_VERSION)
    for (const name of ['tasks:create', 'terminal:attach', 'terminal:write', 'workspaces:switch']) {
      expect(schema.channels[name]).toBeDefined()
    }
    expect(schema.channels['terminal:write']?.kind).toBe('send')
    expect(Object.keys(schema.channels).length).toBeGreaterThan(80)
  })
})
