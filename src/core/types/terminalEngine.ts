/**
 * The terminal engine boundary. A terminal session's PTY belongs to `ptyManager` whatever renders
 * it; an engine only turns that output into a screen. `xterm` (xterm.js in the renderer) is the
 * standard engine and the recovery path. `native` is the experimental Styr Terminal engine: a Rust
 * terminal model in the optional, private `@anoguez/styr-terminal` package, loaded in the main
 * process only when the experiment is switched on. See docs/architecture/terminal-engine.md.
 */
export type TerminalEngineId = 'xterm' | 'native'

/**
 * The native package's protocol version this build of Styr speaks. A package reporting any other
 * `API_VERSION` is incompatible and the session falls back to xterm.js.
 */
export const TERMINAL_ENGINE_API_VERSION = 1

/** What an engine can do, so the UI hides what it lacks rather than silently doing nothing. */
export interface TerminalEngineCapabilities {
  /** Command blocks drawn over the output (needs buffer markers). */
  commandBlocks: boolean
  /** Links in the output open on click. */
  webLinks: boolean
  /** Mouse events are reported to programs that ask for them (vim, htop). */
  mouseReporting: boolean
  /** Text can be selected and copied beyond the visible screen. */
  scrollbackSelection: boolean
  /** Dropped files are pasted as quoted paths. */
  fileDrop: boolean
  /** Bracketed paste is honoured when the program enables it. */
  bracketedPaste: boolean
}

export const TERMINAL_ENGINE_CAPABILITIES: Record<TerminalEngineId, TerminalEngineCapabilities> = {
  xterm: {
    commandBlocks: true,
    webLinks: true,
    mouseReporting: true,
    scrollbackSelection: true,
    fileDrop: true,
    bracketedPaste: true
  },
  native: {
    // Needs a package with command marks (0.2.0 and later); an older one draws no blocks.
    commandBlocks: true,
    webLinks: false,
    mouseReporting: false,
    scrollbackSelection: false,
    fileDrop: true,
    bracketedPaste: true
  }
}

/** The native package's own description of itself (`engineInfo()` in the protocol). */
export interface NativeEngineInfo {
  apiVersion: number
  packageVersion: string
  coreVersion: string
  target: string
}

/** Why the native engine is not in use. Every value is safe to show and to put in a report. */
export type NativeUnavailableReason =
  | 'disabled'
  | 'unsupported-platform'
  | 'missing-package'
  | 'incompatible-version'
  | 'init-failed'
  | 'runtime-error'

/** Whether the native engine can be used on this machine, as the main process found it. */
export type NativeEngineStatus =
  | { available: true; info: NativeEngineInfo; path: string }
  | { available: false; reason: Exclude<NativeUnavailableReason, 'disabled'>; detail: string }

/**
 * A non-sensitive record of which engine a session got and why: no terminal contents, no
 * environment, no paths beyond the package's own location.
 */
export interface TerminalEngineDiagnostic {
  sessionId: string
  requested: TerminalEngineId
  selected: TerminalEngineId
  fallbackReason?: NativeUnavailableReason
  /** A short, contents-free description of what failed, e.g. an exception's message. */
  detail?: string
  engineVersion?: string
  coreVersion?: string
  platform: string
  arch: string
  at: number
}

// --- Protocol v1 frame types, mirrored from styr-terminal's docs/PROTOCOL.md. ---

/** `-1` default, `0..=255` palette index, `0x1000000 + 0xRRGGBB` 24-bit colour. */
export type EngineColor = number

export const ENGINE_COLOR_DEFAULT = -1
export const ENGINE_COLOR_RGB = 0x1000000

export const ENGINE_FLAGS = {
  bold: 1,
  italic: 2,
  underline: 4,
  inverse: 8,
  dim: 16,
  strikethrough: 32,
  hidden: 64,
  doubleUnderline: 128,
  undercurl: 256
} as const

export interface EngineRun {
  text: string
  /** Cells covered; a wide character counts two. */
  width: number
  fg: EngineColor
  bg: EngineColor
  flags: number
}

export interface EngineFrameLine {
  row: number
  wrapped: boolean
  runs: EngineRun[]
}

export interface EngineCursor {
  row: number
  col: number
  visible: boolean
  shape: 'block' | 'underline' | 'bar'
}

export interface EngineModes {
  appCursor: boolean
  appKeypad: boolean
  bracketedPaste: boolean
  focusEvents: boolean
  mouse: 'none' | 'click' | 'drag' | 'motion'
  sgrMouse: boolean
}

export interface EngineFrame {
  seq: number
  /** The receiver replaces every row; otherwise `lines` holds only the changed ones. */
  full: boolean
  cols: number
  rows: number
  cursor: EngineCursor
  altScreen: boolean
  modes: EngineModes
  historySize: number
  displayOffset: number
  title?: string
  bell: boolean
  lines: EngineFrameLine[]
}

/** Whether the package is bundled for this platform, found without loading it. */
export interface TerminalEngineAvailability {
  supported: boolean
  present: boolean
  /** From `STYR_EXPERIMENTAL_TERMINAL`: overrides the setting when set. */
  override?: boolean
}

/** What the renderer needs to choose an engine; asking for it loads the package. */
export interface TerminalEngineEnvironment {
  status: NativeEngineStatus
  override?: boolean
  summary: string
}

/**
 * A shell command and the buffer lines it covers, whichever engine tracks it. Lines are absolute:
 * 0 is the oldest line still in the scrollback, so they shift as history is trimmed.
 */
export interface TrackedBlock {
  id: string
  command: string
  startedAt: number
  endedAt?: number
  exitCode?: number
  /** Buffer line of the command's own row (the prompt it was typed on). */
  startLine: number
  /** Buffer line after the last output row, so output is `startLine + 1 … endLine - 1`. */
  endLine: number
  /** Still running: `endLine` follows the cursor. */
  open: boolean
}

/** The answer to the renderer's request to show a session with the native engine. */
export type NativeAttachResult =
  | {
      ok: true
      attachId: number
      frame: EngineFrame
      blocks: TrackedBlock[]
      info: NativeEngineInfo
    }
  | { ok: false; reason: NativeUnavailableReason; detail: string }

/**
 * A frame for one session's engine. `attachId` names the engine it came from, so a frame from an
 * engine that has since been replaced (a remount re-attaches) is never applied to the new one.
 */
export interface NativeFrameEvent {
  id: string
  attachId: number
  /** Absent when only the blocks changed. */
  frame?: EngineFrame
  /** The session's command blocks, present when they changed. */
  blocks?: TrackedBlock[]
}

/** Sent when a native engine stops for a session; the renderer mounts xterm.js in its place. */
export interface NativeEngineFailure {
  id: string
  reason: NativeUnavailableReason
  detail: string
}
