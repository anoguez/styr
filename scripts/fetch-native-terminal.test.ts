import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NATIVE_ENGINE_TARGETS } from '../src/core/terminalEngine.js'
// @ts-expect-error: a plain .mjs build script with no declarations.
import * as fetchScript from './fetch-native-terminal.mjs'

const { checkManifest, checkPackage, integrityOf, keepOnlyBinary, pinned, sha256Of } =
  fetchScript as {
    checkManifest: (manifest: unknown, lock: Lock) => string
    checkPackage: (directory: string, lock: Lock, binary: Binary) => void
    integrityOf: (buffer: Buffer) => string
    keepOnlyBinary: (directory: string, binary: Binary) => string[]
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

  it('pins a binary for every declared target, and nothing else', () => {
    const real = JSON.parse(
      readFileSync(new URL('../native-terminal.lock.json', import.meta.url), 'utf8')
    ) as Lock
    expect(Object.keys(real.binaries).sort()).toEqual([...NATIVE_ENGINE_TARGETS].sort())
    expect(real.binaries['linux-x64']?.file).toBe('styr-terminal.linux-x64-gnu.node')
    expect(real.binaries['win32-x64']?.file).toBe('styr-terminal.win32-x64-msvc.node')
    for (const target of NATIVE_ENGINE_TARGETS) {
      expect(pinned(real, target)).toMatchObject({ binary: real.binaries[target] })
      expect(real.binaries[target]?.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
    for (const target of ['linux-arm64', 'win32-arm64', 'darwin-x64'])
      expect(pinned(real, target)).toEqual({ skip: `no binary pinned for ${target}` })
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
  it('keeps only the pinned binary, and the rest of the package', () => {
    directory = mkdtempSync(join(tmpdir(), 'styr-fetch-'))
    const binary = lock.binaries['darwin-arm64']!
    const kept = ['index.js', 'index.d.ts', 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']
    for (const file of [
      ...kept,
      binary.file,
      'styr-terminal.linux-x64-gnu.node',
      'styr-terminal.win32-x64-msvc.node'
    ])
      writeFileSync(join(directory, file), file)
    expect(keepOnlyBinary(directory, binary).sort()).toEqual([
      'styr-terminal.linux-x64-gnu.node',
      'styr-terminal.win32-x64-msvc.node'
    ])
    expect(readdirSync(directory).sort()).toEqual([...kept, binary.file].sort())
    expect(keepOnlyBinary(directory, binary)).toEqual([])
  })
})
