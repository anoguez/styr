import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  candidatePaths,
  findNativePackage,
  loadNativeEngine,
  PACKAGE_NAME,
  type LoaderEnvironment
} from './nativeEngine.js'
import { FakeEngine, fakeNativeModule } from './nativeEngineFixture.js'

const bundled = join('/app', 'resources', 'native', 'styr-terminal')

function env(overrides: Partial<LoaderEnvironment> = {}): LoaderEnvironment {
  return {
    platform: 'darwin',
    arch: 'arm64',
    isPackaged: false,
    appPath: '/app',
    exists: (path) => path === bundled,
    load: () => fakeNativeModule(),
    ...overrides
  }
}

beforeEach(() => {
  FakeEngine.instances = []
})

describe('loadNativeEngine', () => {
  it('loads a compatible package and probes it before trusting it', () => {
    const result = loadNativeEngine(env())
    expect(result.status).toMatchObject({
      available: true,
      path: bundled,
      info: { apiVersion: 1, packageVersion: '0.1.0-test' }
    })
    // The probe engine was created, used and freed.
    expect(FakeEngine.instances).toHaveLength(1)
    expect(FakeEngine.instances[0]!.disposed).toBe(true)
    const engine = result.factory!.create({ cols: 80, rows: 24, scrollback: 100 })
    expect(engine).toBeInstanceOf(FakeEngine)
  })

  it('refuses an unsupported platform without looking for the package', () => {
    let looked = false
    const result = loadNativeEngine(
      env({
        platform: 'linux',
        arch: 'x64',
        load: () => {
          looked = true
          return fakeNativeModule()
        }
      })
    )
    expect(result.status).toEqual({
      available: false,
      reason: 'unsupported-platform',
      detail: 'linux-x64'
    })
    expect(looked).toBe(false)
  })

  it('reports a missing package as an expected, non-fatal condition', () => {
    const result = loadNativeEngine(
      env({
        exists: () => false,
        load: (specifier) => {
          throw new Error(`Cannot find module '${specifier}' from /Users/someone/app`)
        }
      })
    )
    expect(result.status).toMatchObject({ available: false, reason: 'missing-package' })
    // Paths are not leaked into the diagnostic.
    expect(result.status.available || result.status.detail).not.toContain('/Users/someone')
  })

  it('falls back to resolving the package by name when no bundled copy exists', () => {
    const asked: string[] = []
    loadNativeEngine(
      env({
        exists: () => false,
        load: (specifier) => {
          asked.push(specifier)
          return fakeNativeModule()
        }
      })
    )
    expect(asked).toEqual([PACKAGE_NAME])
  })

  it('refuses an incompatible API version', () => {
    const result = loadNativeEngine(env({ load: () => fakeNativeModule({ API_VERSION: 2 }) }))
    expect(result.status).toMatchObject({ available: false, reason: 'incompatible-version' })
    expect(FakeEngine.instances).toHaveLength(0)
  })

  it('refuses a module that is not shaped like the package', () => {
    const result = loadNativeEngine(env({ load: () => ({ hello: 'world' }) }))
    expect(result.status).toMatchObject({ available: false, reason: 'incompatible-version' })
  })

  it('refuses when engineInfo itself throws', () => {
    const result = loadNativeEngine(
      env({
        load: () =>
          fakeNativeModule({
            engineInfo: () => {
              throw new Error('boom')
            }
          })
      })
    )
    expect(result.status).toMatchObject({ available: false, reason: 'incompatible-version' })
  })

  it('reports an engine that cannot be created as an initialisation failure', () => {
    class Broken {
      constructor() {
        throw new Error('styr-terminal: unsupported CPU')
      }
    }
    const result = loadNativeEngine(
      env({ load: () => fakeNativeModule({ TerminalEngine: Broken }) })
    )
    expect(result.status).toEqual({
      available: false,
      reason: 'init-failed',
      detail: 'styr-terminal: unsupported CPU'
    })
  })

  it('reports an engine whose probe frame is empty as an initialisation failure', () => {
    class Silent extends FakeEngine {
      override takeFrame(): null {
        return null
      }
    }
    const result = loadNativeEngine(
      env({ load: () => fakeNativeModule({ TerminalEngine: Silent }) })
    )
    expect(result.status).toMatchObject({ available: false, reason: 'init-failed' })
    expect(FakeEngine.instances[0]!.disposed).toBe(true)
  })
})

describe('candidatePaths', () => {
  it('looks only in the app resources when packaged, ignoring STYR_TERMINAL_PATH', () => {
    expect(
      candidatePaths(env({ isPackaged: true, resourcesPath: '/R', devPath: '/elsewhere' }))
    ).toEqual([join('/R', 'native', 'styr-terminal')])
  })

  it('honours STYR_TERMINAL_PATH first in a dev build', () => {
    expect(candidatePaths(env({ devPath: '/dev/pkg' }))).toEqual(['/dev/pkg', bundled])
  })
})

describe('findNativePackage', () => {
  it('finds the package without loading it', () => {
    let loaded = false
    const presence = findNativePackage(
      env({
        load: () => {
          loaded = true
          return {}
        }
      })
    )
    expect(presence).toEqual({ supported: true, present: true })
    expect(loaded).toBe(false)
  })

  it('reports absence on an unsupported platform even if files exist', () => {
    expect(findNativePackage(env({ platform: 'win32', arch: 'x64' }))).toEqual({
      supported: false,
      present: false
    })
  })
})
