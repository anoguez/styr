import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bundleHashes, fetchBundle, runSsh, uploadFile } from './sshRunner.js'

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const NAME = 'styr-server-1.2.0-linux-x64.tar.gz'

let dir: string
let path: string | undefined
let bundleDir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'styr-runner-'))
  path = process.env.PATH
  bundleDir = process.env.STYR_SERVER_BUNDLE_DIR
  delete process.env.STYR_SERVER_BUNDLE_DIR
})

afterEach(() => {
  process.env.PATH = path
  if (bundleDir === undefined) delete process.env.STYR_SERVER_BUNDLE_DIR
  else process.env.STYR_SERVER_BUNDLE_DIR = bundleDir
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('the bundle on this computer (the upload fallback)', () => {
  it('downloads it, checks it against the app’s hash, and keeps it for next time', async () => {
    const body = 'the bundle'
    const fetch = vi.fn(async () => new Response(body))
    vi.stubGlobal('fetch', fetch)
    const cache = join(dir, 'cache')
    const file = await fetchBundle(cache, '1.2.0', 'x64', sha256(body))
    expect(file).toBe(join(cache, NAME))
    expect(readFileSync(file, 'utf8')).toBe(body)
    expect(fetch).toHaveBeenCalledWith(
      `https://github.com/anoguez/styr/releases/download/v1.2.0/${NAME}`
    )
    await fetchBundle(cache, '1.2.0', 'x64', sha256(body))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses a download that does not match the hash built into the app, keeping nothing', async () => {
    vi.stubGlobal('fetch', async () => new Response('tampered'))
    const cache = join(dir, 'cache')
    await expect(fetchBundle(cache, '1.2.0', 'x64', sha256('the bundle'))).rejects.toThrow(
      `${NAME} does not match the SHA-256 built into this app, so it was refused.`
    )
    expect(existsSync(join(cache, NAME))).toBe(false)
  })

  it('uses STYR_SERVER_BUNDLE_DIR in development, checked the same way', async () => {
    writeFileSync(join(dir, NAME), 'local build')
    process.env.STYR_SERVER_BUNDLE_DIR = dir
    expect(await fetchBundle(join(dir, 'cache'), '1.2.0', 'x64', sha256('local build'))).toBe(
      join(dir, NAME)
    )
    await expect(fetchBundle(join(dir, 'cache'), '1.2.0', 'x64', 'f'.repeat(64))).rejects.toThrow(
      /refused/
    )
  })

  it('reads the hashes built into the app for this version only', () => {
    const file = join(dir, 'serverBundles.json')
    writeFileSync(file, JSON.stringify({ version: '1.2.0', sha256: { x64: 'a'.repeat(64) } }))
    expect(bundleHashes(file, '1.2.0')('x64')).toBe('a'.repeat(64))
    expect(bundleHashes(file, '1.2.0')('arm64')).toBeUndefined()
    expect(bundleHashes(file, '1.3.0')('x64')).toBeUndefined()
    expect(bundleHashes(join(dir, 'missing.json'), '1.2.0')('x64')).toBeUndefined()
    // Development: the local bundle's own hash stands in.
    writeFileSync(join(dir, NAME), 'local build')
    process.env.STYR_SERVER_BUNDLE_DIR = dir
    expect(bundleHashes(join(dir, 'missing.json'), '1.2.0')('x64')).toBe(sha256('local build'))
  })
})

// Stand-in `ssh` and `scp` on PATH: ssh runs its last argument in a local sh with the home folder
// set to `remote/`, as the host would; scp fails as on a host without the sftp subsystem.
describe.skipIf(process.platform === 'win32')('ssh and the upload', () => {
  let remote: string
  let log: string

  beforeEach(() => {
    remote = join(dir, 'remote')
    log = join(dir, 'log')
    mkdirSync(remote)
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'ssh'),
      `#!/bin/sh\necho "ssh $*" >> '${log}'\nfor last; do :; done\ncd '${remote}' && HOME='${remote}' exec sh -c "$last"\n`
    )
    writeFileSync(
      join(bin, 'scp'),
      `#!/bin/sh\necho "scp $*" >> '${log}'\necho "subsystem request failed on channel 0" >&2\nexit 1\n`
    )
    chmodSync(join(bin, 'ssh'), 0o755)
    chmodSync(join(bin, 'scp'), 0o755)
    process.env.PATH = `${bin}:/usr/bin:/bin`
  })

  it('runs a command in batch mode, feeding stdin and reporting what happened', async () => {
    const result = await runSsh(
      'devbox',
      'sh -s -- --probe',
      'echo "::styr os=$(echo Linux)"\nexit 3\n'
    )
    expect(result).toEqual({ code: 3, stdout: '::styr os=Linux\n', stderr: '' })
    const line = readFileSync(log, 'utf8')
    expect(line).toContain('-T -o BatchMode=yes -o ConnectTimeout=10 devbox sh -s -- --probe')
    expect(line).not.toMatch(/StrictHostKeyChecking|accept-new/)
  })

  it('falls back from scp to ssh … cat, and says which it used', async () => {
    const file = join(dir, 'bundle.tgz')
    writeFileSync(file, 'bundle bytes')
    expect(await uploadFile('devbox', file, '.styr/server/upload it.tgz')).toBe('ssh')
    expect(readFileSync(join(remote, '.styr', 'server', 'upload it.tgz'), 'utf8')).toBe(
      'bundle bytes'
    )
    expect(readFileSync(log, 'utf8')).toMatch(
      /scp -q -B -o BatchMode=yes -o ConnectTimeout=10 .*bundle\.tgz devbox:\.styr\/server\/upload it\.tgz/
    )
  })
})
