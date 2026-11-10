import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listen, type Listener } from '../socket.js'
import { createAllowList } from './allowList.js'
import { parseRelayArgs } from './cli.js'
import { createRelayControl, relayControl } from './control.js'
import type { Relay } from './relay.js'

const FP = 'ab'.repeat(32)

describe('parseRelayArgs', () => {
  it('runs on a listen address, port 7879 unless given', () => {
    expect(parseRelayArgs(['--listen', '100.64.1.2'])).toEqual({
      command: 'run',
      listen: { address: '100.64.1.2', port: 7879 }
    })
    expect(parseRelayArgs(['--listen=[fd7a::1]:9000', '--socket', '/tmp/r.sock'])).toEqual({
      command: 'run',
      listen: { address: 'fd7a::1', port: 9000 },
      socket: '/tmp/r.sock'
    })
  })

  it('takes a fingerprint as it is pasted', () => {
    const pasted = FP.toUpperCase().match(/../g)!.join(':')
    expect(parseRelayArgs(['allow', pasted])).toEqual({ command: 'allow', fingerprint: FP })
    expect(parseRelayArgs(['revoke', FP])).toEqual({ command: 'revoke', fingerprint: FP })
    expect(parseRelayArgs(['hosts'])).toEqual({ command: 'hosts' })
  })

  it('refuses what it does not know', () => {
    expect(parseRelayArgs([])).toMatchObject({ command: 'invalid' })
    expect(parseRelayArgs(['allow'])).toMatchObject({ command: 'invalid' })
    expect(parseRelayArgs(['allow', 'abc'])).toMatchObject({ command: 'invalid' })
    expect(parseRelayArgs(['hosts', '--listen', '127.0.0.1'])).toMatchObject({
      command: 'invalid'
    })
    expect(parseRelayArgs(['stop'])).toMatchObject({ command: 'invalid' })
    expect(parseRelayArgs(['--help'])).toEqual({ command: 'help' })
  })
})

describe('allow list', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'styr-allow-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps fingerprints in a file only the user can read', () => {
    const path = join(dir, 'relay.json')
    const list = createAllowList(path, () => new Date('2026-11-10T00:00:00Z'))
    expect(list.allow(FP)).toBe(true)
    expect(list.allow(FP)).toBe(false)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(createAllowList(path).list()).toEqual([
      { fingerprint: FP, addedAt: '2026-11-10T00:00:00.000Z' }
    ])
    expect(() => list.allow('nope')).toThrow('Not a host fingerprint')
    expect(list.revoke(FP)).toBe(true)
    expect(list.revoke(FP)).toBe(false)
    expect(createAllowList(path).has(FP)).toBe(false)
  })

  it('will not start over a file it cannot read, and keeps what it had on a bad reload', () => {
    const path = join(dir, 'relay.json')
    writeFileSync(path, '{ broken')
    expect(() => createAllowList(path)).toThrow('cannot be read')
    writeFileSync(path, JSON.stringify({ version: 1, hosts: [{ fingerprint: FP, addedAt: 'x' }] }))
    const list = createAllowList(path)
    writeFileSync(path, '{ broken')
    list.reload()
    expect(list.has(FP)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('{ broken')
  })

  it('keeps a hand edit made while it runs, and will not write over a broken file', () => {
    const path = join(dir, 'relay.json')
    const other = 'cd'.repeat(32)
    const list = createAllowList(path)
    list.allow(FP)
    writeFileSync(
      path,
      JSON.stringify({ version: 1, hosts: [...list.list(), { fingerprint: other, addedAt: 'x' }] })
    )
    list.revoke(FP)
    expect(
      createAllowList(path)
        .list()
        .map((host) => host.fingerprint)
    ).toEqual([other])
    writeFileSync(path, '{ broken')
    expect(() => list.allow(FP)).toThrow('cannot be read')
    expect(readFileSync(path, 'utf8')).toBe('{ broken')
  })
})

describe.skipIf(process.platform === 'win32')(
  'styr relay allow | hosts | revoke over the Unix socket',
  () => {
    let dir: string
    let listener: Listener
    const disconnected: string[] = []
    const relay: Relay = {
      address: { address: '127.0.0.1', port: 1 },
      hosts: () => [{ fingerprint: FP, sessions: 2 }],
      disconnectHost: (fingerprint) => void disconnected.push(fingerprint),
      close: async () => undefined
    }

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'styr-ctl-'))
      const allowList = createAllowList(join(dir, 'relay.json'), () => new Date(0))
      listener = await listen(join(dir, 'r.sock'), createRelayControl(allowList, relay))
    })
    afterEach(async () => {
      await listener.close()
      rmSync(dir, { recursive: true, force: true })
    })

    async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
      const out = new PassThrough()
      const err = new PassThrough()
      const parsed = parseRelayArgs([...args, '--socket', join(dir, 'r.sock')])
      const code = await relayControl(parsed as never, join(dir, 'r.sock'), out, err)
      return { code, out: out.read()?.toString() ?? '', err: err.read()?.toString() ?? '' }
    }

    it('allows, lists and revokes, ending the revoked host at once', async () => {
      expect((await run(['hosts'])).out).toContain('No hosts allowed')
      expect((await run(['allow', FP])).out).toContain(`Allowed ${FP}`)
      expect((await run(['hosts'])).out).toBe(
        `${FP}  connected, 2 sessions  allowed 1970-01-01T00:00:00.000Z\n`
      )
      expect(await run(['revoke', FP])).toMatchObject({ code: 0 })
      expect(disconnected).toEqual([FP])
      expect(await run(['revoke', FP])).toMatchObject({ code: 1 })
    })

    it('says when no relay is running', async () => {
      const out = new PassThrough()
      const err = new PassThrough()
      const code = await relayControl({ command: 'hosts' }, join(dir, 'none.sock'), out, err)
      expect(code).toBe(1)
      expect(err.read().toString()).toContain('no Styr relay is running')
    })
  }
)
