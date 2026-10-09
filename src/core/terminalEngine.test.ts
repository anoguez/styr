import { describe, expect, it } from 'vitest'
import {
  checkNativeModule,
  describeNativeStatus,
  diagnosticDetail,
  experimentalTerminalOverride,
  isNativeTargetSupported,
  selectTerminalEngine
} from './terminalEngine.js'
import { shippedSettings } from './config.js'
import { settingsSchema } from './taskSchema.js'
import type { NativeEngineStatus } from './types.js'

const info = {
  apiVersion: 1,
  packageVersion: '0.1.0',
  coreVersion: '0.1.0 (alacritty_terminal)',
  target: 'aarch64-apple-darwin'
}
const available: NativeEngineStatus = { available: true, info, path: '/pkg' }

describe('selectTerminalEngine', () => {
  it('uses xterm.js by default', () => {
    expect(selectTerminalEngine({ settingEnabled: false, status: available })).toEqual({
      requested: 'xterm',
      selected: 'xterm'
    })
  })

  it('uses xterm.js when the experiment is off, even without a status', () => {
    expect(selectTerminalEngine({ settingEnabled: false, status: null }).selected).toBe('xterm')
  })

  it('uses the native engine when enabled and available', () => {
    expect(selectTerminalEngine({ settingEnabled: true, status: available })).toEqual({
      requested: 'native',
      selected: 'native'
    })
  })

  it.each([
    ['unsupported-platform', 'linux-x64'],
    ['missing-package', 'not bundled'],
    ['incompatible-version', 'API 2, Styr needs 1'],
    ['init-failed', 'probe failed']
  ] as const)('falls back to xterm.js when the engine is %s', (reason, detail) => {
    expect(
      selectTerminalEngine({ settingEnabled: true, status: { available: false, reason, detail } })
    ).toEqual({ requested: 'native', selected: 'xterm', fallbackReason: reason, detail })
  })

  it('falls back when the status could not be read', () => {
    expect(selectTerminalEngine({ settingEnabled: true, status: null })).toMatchObject({
      selected: 'xterm',
      fallbackReason: 'missing-package'
    })
  })

  it('lets STYR_EXPERIMENTAL_TERMINAL override the setting either way', () => {
    expect(
      selectTerminalEngine({ settingEnabled: false, override: true, status: available }).selected
    ).toBe('native')
    expect(
      selectTerminalEngine({ settingEnabled: true, override: false, status: available }).selected
    ).toBe('xterm')
  })
})

describe('experimentalTerminalOverride', () => {
  it('reads 1 and 0 and ignores anything else', () => {
    expect(experimentalTerminalOverride('1')).toBe(true)
    expect(experimentalTerminalOverride('0')).toBe(false)
    expect(experimentalTerminalOverride(undefined)).toBeUndefined()
    expect(experimentalTerminalOverride('yes')).toBeUndefined()
  })
})

describe('isNativeTargetSupported', () => {
  it('supports only the targets the engine is built for', () => {
    expect(isNativeTargetSupported('darwin', 'arm64')).toBe(true)
    expect(isNativeTargetSupported('darwin', 'x64')).toBe(false)
    expect(isNativeTargetSupported('win32', 'x64')).toBe(false)
    expect(isNativeTargetSupported('linux', 'x64')).toBe(false)
  })
})

describe('checkNativeModule', () => {
  const module = (overrides: Record<string, unknown> = {}) => ({
    API_VERSION: 1,
    engineInfo: () => info,
    TerminalEngine: class {},
    ...overrides
  })

  it('accepts a module speaking protocol 1', () => {
    expect(checkNativeModule(module())).toEqual({ ok: true, info })
  })

  it.each([null, undefined, 42, {}, { API_VERSION: 1 }])('refuses %p', (value) => {
    expect(checkNativeModule(value)).toMatchObject({ ok: false, reason: 'incompatible-version' })
  })

  it('refuses another API version', () => {
    expect(checkNativeModule(module({ API_VERSION: 2 }))).toEqual({
      ok: false,
      reason: 'incompatible-version',
      detail: 'API 2, Styr needs 1'
    })
  })

  it('refuses a module whose engineInfo disagrees with its constant', () => {
    expect(
      checkNativeModule(module({ engineInfo: () => ({ ...info, apiVersion: 3 }) }))
    ).toMatchObject({ ok: false, detail: 'engineInfo reports API 3' })
  })
})

describe('diagnosticDetail', () => {
  it('keeps the first line, hides absolute paths and caps the length', () => {
    expect(
      diagnosticDetail(
        new Error("Cannot find module '@anoguez/styr-terminal' from /Users/me/app\nstack")
      )
    ).toBe("Cannot find module '@anoguez/styr-terminal' from <path>")
    expect(diagnosticDetail('dlopen C:\\Users\\me\\x.node failed')).toBe('dlopen <path> failed')
    expect(diagnosticDetail('x'.repeat(500))).toHaveLength(200)
  })
})

describe('describeNativeStatus', () => {
  it('describes each status in a line', () => {
    expect(describeNativeStatus(null)).toBe('Not checked yet')
    expect(describeNativeStatus(available)).toBe('Styr Terminal 0.1.0 (aarch64-apple-darwin)')
    expect(
      describeNativeStatus({ available: false, reason: 'unsupported-platform', detail: '' })
    ).toBe('Not available on this platform')
    expect(describeNativeStatus({ available: false, reason: 'missing-package', detail: '' })).toBe(
      'Not included in this build'
    )
    expect(
      describeNativeStatus({ available: false, reason: 'incompatible-version', detail: 'API 2' })
    ).toBe('Incompatible engine: API 2')
    expect(describeNativeStatus({ available: false, reason: 'init-failed', detail: 'x' })).toBe(
      'Failed to start: x'
    )
  })
})

describe('the experimental setting', () => {
  it('is off by default and in an old config file', () => {
    expect(shippedSettings().experimental.nativeTerminal).toBe(false)
    const parsed = settingsSchema.shape.experimental.parse({ externalSources: true })
    expect(parsed).toEqual({ externalSources: true, nativeTerminal: false })
  })
})
