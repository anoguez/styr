import {
  TERMINAL_ENGINE_API_VERSION,
  type NativeEngineInfo,
  type NativeEngineStatus,
  type NativeUnavailableReason,
  type TerminalEngineId
} from './types.js'

/**
 * Engine selection, kept pure so every case is testable without the private package. The main
 * process works out `NativeEngineStatus` (see `main/terminal/nativeEngine.ts`); the renderer asks
 * `selectTerminalEngine` which engine a new terminal view gets.
 */

/** Where the experimental engine has been built and verified. Everywhere else stays on xterm.js. */
export const NATIVE_ENGINE_TARGETS: readonly string[] = ['darwin-arm64']

export function isNativeTargetSupported(platform: string, arch: string): boolean {
  return NATIVE_ENGINE_TARGETS.includes(`${platform}-${arch}`)
}

/**
 * `STYR_EXPERIMENTAL_TERMINAL` for internal builds: `1` turns the native engine on whatever the
 * setting says, `0` turns it off, anything else (or unset) defers to the setting.
 */
export function experimentalTerminalOverride(value: string | undefined): boolean | undefined {
  if (value === '1') return true
  if (value === '0') return false
  return undefined
}

export interface EngineRequest {
  /** `experimental.nativeTerminal` in Settings. */
  settingEnabled: boolean
  /** `experimentalTerminalOverride(process.env.STYR_EXPERIMENTAL_TERMINAL)`. */
  override?: boolean
  status: NativeEngineStatus | null
}

export interface EngineSelection {
  requested: TerminalEngineId
  selected: TerminalEngineId
  /** Why `native` was requested but `xterm` selected; absent when the request was honoured. */
  fallbackReason?: NativeUnavailableReason
  detail?: string
}

/** Standard mode is always xterm.js; native only when asked for and the module is usable. */
export function selectTerminalEngine({
  settingEnabled,
  override,
  status
}: EngineRequest): EngineSelection {
  const wanted = override ?? settingEnabled
  if (!wanted) return { requested: 'xterm', selected: 'xterm' }
  if (!status) {
    return {
      requested: 'native',
      selected: 'xterm',
      fallbackReason: 'missing-package',
      detail: 'Engine status unknown'
    }
  }
  if (!status.available) {
    return {
      requested: 'native',
      selected: 'xterm',
      fallbackReason: status.reason,
      detail: status.detail
    }
  }
  return { requested: 'native', selected: 'native' }
}

/** Only these exports are used; anything more a package offers is ignored. */
export interface NativeModuleShape {
  API_VERSION: number
  engineInfo: () => NativeEngineInfo
  TerminalEngine: new (options: { cols: number; rows: number; scrollback: number }) => unknown
}

export type CompatibilityCheck =
  | { ok: true; info: NativeEngineInfo }
  | { ok: false; reason: 'incompatible-version'; detail: string }

/**
 * Whether a loaded module speaks the protocol this build was written for. The shape is checked as
 * well as the number, so a package that is not ours (or a broken build) is refused, not called.
 */
export function checkNativeModule(module: unknown): CompatibilityCheck {
  const candidate = module as Partial<NativeModuleShape> | null
  if (
    !candidate ||
    typeof candidate.API_VERSION !== 'number' ||
    typeof candidate.engineInfo !== 'function' ||
    typeof candidate.TerminalEngine !== 'function'
  ) {
    return { ok: false, reason: 'incompatible-version', detail: 'Not a Styr Terminal module' }
  }
  if (candidate.API_VERSION !== TERMINAL_ENGINE_API_VERSION) {
    return {
      ok: false,
      reason: 'incompatible-version',
      detail: `API ${candidate.API_VERSION}, Styr needs ${TERMINAL_ENGINE_API_VERSION}`
    }
  }
  const info = candidate.engineInfo()
  if (info.apiVersion !== TERMINAL_ENGINE_API_VERSION) {
    return {
      ok: false,
      reason: 'incompatible-version',
      detail: `engineInfo reports API ${info.apiVersion}`
    }
  }
  return { ok: true, info }
}

/**
 * An exception's message, cut short and stripped of anything path- or content-like enough to be
 * worth hiding, for a diagnostic that may be pasted into a bug report.
 */
export function diagnosticDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split('\n')[0] ?? ''
  // An absolute path (POSIX or Windows) at the start of a word; a package name's slash is kept.
  return firstLine.replace(/(^|[\s'"(])(\/|[A-Za-z]:\\)[^\s'")]+/g, '$1<path>').slice(0, 200)
}

/** A one-line description of a status, for the Settings row and the diagnostics report. */
export function describeNativeStatus(status: NativeEngineStatus | null): string {
  if (!status) return 'Not checked yet'
  if (status.available) return `Styr Terminal ${status.info.packageVersion} (${status.info.target})`
  switch (status.reason) {
    case 'unsupported-platform':
      return 'Not available on this platform'
    case 'missing-package':
      return 'Not included in this build'
    case 'incompatible-version':
      return `Incompatible engine: ${status.detail}`
    default:
      return `Failed to start: ${status.detail}`
  }
}
