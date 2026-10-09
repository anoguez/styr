import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs build script with no declarations.
import * as fetchScript from './fetch-native-terminal.mjs'

const { checkManifest, checkPackage, integrityOf, pinned, sha256Of } = fetchScript as {
  checkManifest: (manifest: unknown, lock: Lock) => string
  checkPackage: (directory: string, lock: Lock, binary: Binary) => void
  integrityOf: (buffer: Buffer) => string
  pinned: (lock: Partial<Lock> | null, target: string) => Record<string, unknown>
  sha256Of: (buffer: Buffer) => string
}

interface Binary {
  file: string
  sha256: string
}
interface Lock {
  package: string
  registry: string
  version: string
  integrity: string
  binaries: Record<string, Binary>
}

const binaryBytes = Buffer.from('not really a Mach-O')
const lock: Lock = {
  package: '@anoguez/styr-terminal',
  registry: 'https://npm.pkg.github.com',
  version: '0.1.0',
  integrity: integrityOf(Buffer.from('tarball')),
  binaries: {
    'darwin-arm64': { file: 'styr-terminal.darwin-arm64.node', sha256: sha256Of(binaryBytes) }
  }
}

let directory: string | undefined
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

describe('fetch-native-terminal', () => {
  it('skips, rather than fails, when nothing is pinned', () => {
    expect(pinned(null, 'darwin-arm64')).toHaveProperty('skip')
    expect(pinned({ ...lock, version: null as never }, 'darwin-arm64')).toHaveProperty('skip')
    expect(pinned(lock, 'linux-x64')).toEqual({ skip: 'no binary pinned for linux-x64' })
    expect(pinned(lock, 'darwin-arm64')).toEqual({
      version: '0.1.0',
      integrity: lock.integrity,
      binary: lock.binaries['darwin-arm64']
    })
  })

  it('accepts a registry record that matches the pin', () => {
    const manifest = {
      versions: {
        '0.1.0': {
          dist: {
            integrity: lock.integrity,
            tarball: 'https://npm.pkg.github.com/download/@anoguez/styr-terminal/0.1.0/x.tgz'
          }
        }
      }
    }
    expect(checkManifest(manifest, lock)).toContain('/0.1.0/')
  })

  it.each([
    [{ versions: {} }, 'is not in the registry'],
    [
      {
        versions: {
          '0.1.0': { dist: { integrity: 'sha512-other', tarball: 'https://npm.pkg.github.com/x' } }
        }
      },
      'does not match'
    ],
    [
      {
        versions: {
          '0.1.0': { dist: { integrity: lock.integrity, tarball: 'https://evil.example/x.tgz' } }
        }
      },
      'not the pinned registry'
    ]
  ])('refuses a registry record that does not match the pin (%#)', (manifest, message) => {
    expect(() => checkManifest(manifest, lock)).toThrow(message)
  })

  it('verifies the unpacked package name, version and binary hash', () => {
    directory = mkdtempSync(join(tmpdir(), 'styr-fetch-'))
    const binary = lock.binaries['darwin-arm64']!
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: lock.package, version: '0.1.0' })
    )
    expect(() => checkPackage(directory!, lock, binary)).toThrow('is missing')
    writeFileSync(join(directory, binary.file), binaryBytes)
    expect(() => checkPackage(directory!, lock, binary)).not.toThrow()
    writeFileSync(join(directory, binary.file), Buffer.from('tampered'))
    expect(() => checkPackage(directory!, lock, binary)).toThrow('does not match the lock file')
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: lock.package, version: '9.9.9' })
    )
    expect(() => checkPackage(directory!, lock, binary)).toThrow(
      'expected @anoguez/styr-terminal@0.1.0'
    )
  })
})
