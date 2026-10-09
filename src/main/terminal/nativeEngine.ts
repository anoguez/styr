import { join } from 'node:path'
import {
  checkNativeModule,
  diagnosticDetail,
  isNativeTargetSupported,
  type NativeModuleShape
} from '@core/terminalEngine.js'
import type {
  EngineFrame,
  NativeEngineInfo,
  NativeEngineStatus,
  TerminalEngineAvailability
} from '@core/types.js'

/**
 * Loads the optional Styr Terminal package (`@anoguez/styr-terminal`). It is deliberately not in
 * package.json: it lives in a private registry, and a public install must succeed without it. A
 * release that includes it vendors it into `resources/native/styr-terminal` (see
 * scripts/fetch-native-terminal.mjs), which electron-builder copies to the app's resources. Nothing
 * here throws: every way the module can be unusable becomes a `NativeEngineStatus`.
 */

/** One engine instance, as protocol v1 describes it (styr-terminal's docs/PROTOCOL.md). */
export interface NativeTerminalEngine {
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  scroll: (lines: number) => void
  scrollToBottom: () => void
  takeFrame: () => EngineFrame | null
  snapshot: () => EngineFrame
  takeResponses: () => string
  text: () => string
  lines: (from: number, to: number) => string
  reset: () => void
  dispose: () => void
}

export interface NativeEngineFactory {
  info: NativeEngineInfo
  create: (options: { cols: number; rows: number; scrollback: number }) => NativeTerminalEngine
}

export const PACKAGE_NAME = '@anoguez/styr-terminal'

export interface LoaderEnvironment {
  platform: string
  arch: string
  isPackaged: boolean
  /** `process.resourcesPath` when packaged. */
  resourcesPath?: string
  /** The app's root (where package.json is) in a dev build. */
  appPath: string
  /** `STYR_TERMINAL_PATH`: a package directory to load instead, honoured only in a dev build. */
  devPath?: string
  exists: (path: string) => boolean
  /** `require` for a package directory or name; throws when it cannot be loaded. */
  load: (specifier: string) => unknown
}

/** Where the package may be, most specific first. */
export function candidatePaths(env: LoaderEnvironment): string[] {
  if (env.isPackaged) {
    return env.resourcesPath ? [join(env.resourcesPath, 'native', 'styr-terminal')] : []
  }
  return [
    ...(env.devPath ? [env.devPath] : []),
    join(env.appPath, 'resources', 'native', 'styr-terminal')
  ]
}

export type NativePresence = Omit<TerminalEngineAvailability, 'override'>

/** Whether the package is present, found without loading it — for showing the setting. */
export function findNativePackage(env: LoaderEnvironment): NativePresence {
  const supported = isNativeTargetSupported(env.platform, env.arch)
  return {
    supported,
    present: supported && candidatePaths(env).some((candidate) => env.exists(candidate))
  }
}

/** A tiny engine is made, written to, read and freed before the real thing is trusted. */
function probe(factory: NativeEngineFactory): void {
  const engine = factory.create({ cols: 8, rows: 2, scrollback: 10 })
  try {
    engine.write('ok\r\n')
    const frame = engine.takeFrame()
    if (!frame || !Array.isArray(frame.lines)) throw new Error('Probe frame was empty')
  } finally {
    engine.dispose()
  }
}

export type LoadResult =
  | { status: Extract<NativeEngineStatus, { available: true }>; factory: NativeEngineFactory }
  | { status: Extract<NativeEngineStatus, { available: false }>; factory?: undefined }

export function loadNativeEngine(env: LoaderEnvironment): LoadResult {
  if (!isNativeTargetSupported(env.platform, env.arch)) {
    return {
      status: {
        available: false,
        reason: 'unsupported-platform',
        detail: `${env.platform}-${env.arch}`
      }
    }
  }
  const path = candidatePaths(env).find((candidate) => env.exists(candidate))
  let module: unknown
  try {
    module = env.load(path ?? PACKAGE_NAME)
  } catch (error) {
    return {
      status: { available: false, reason: 'missing-package', detail: diagnosticDetail(error) }
    }
  }
  let check: ReturnType<typeof checkNativeModule>
  try {
    check = checkNativeModule(module)
  } catch (error) {
    return {
      status: { available: false, reason: 'incompatible-version', detail: diagnosticDetail(error) }
    }
  }
  if (!check.ok) return { status: { available: false, reason: check.reason, detail: check.detail } }
  const { TerminalEngine } = module as NativeModuleShape
  const factory: NativeEngineFactory = {
    info: check.info,
    create: (options) => new TerminalEngine(options) as NativeTerminalEngine
  }
  try {
    probe(factory)
  } catch (error) {
    return { status: { available: false, reason: 'init-failed', detail: diagnosticDetail(error) } }
  }
  return { status: { available: true, info: check.info, path: path ?? PACKAGE_NAME }, factory }
}
