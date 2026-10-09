import { TERMINAL_ENGINE_API_VERSION, type EngineFrame } from '@core/types.js'
import type { NativeTerminalEngine } from './nativeEngine.js'

/**
 * A stand-in for `@anoguez/styr-terminal` that speaks protocol v1 well enough to test Styr's side
 * of the boundary without the private package: it keeps written text as lines (CR/LF only, no
 * escape sequences) and records every call. Public tests and CI use this; nothing proprietary.
 */
export class FakeEngine implements NativeTerminalEngine {
  static instances: FakeEngine[] = []
  written = ''
  disposed = false
  cols: number
  rows: number
  seq = 0
  dirty = true
  responses = ''
  /** Marked lines by id, numbered like `screenLines()` (the fake keeps no separate history). */
  readonly marks = new Map<string, number>()
  /** Makes the next call to the named method throw, as a poisoned native engine would. */
  failOn: keyof NativeTerminalEngine | null = null

  constructor(options: { cols: number; rows: number; scrollback: number }) {
    this.cols = options.cols
    this.rows = options.rows
    FakeEngine.instances.push(this)
  }

  private check(method: keyof NativeTerminalEngine): void {
    if (this.disposed && method !== 'dispose') throw new Error('styr-terminal: engine is disposed')
    if (this.failOn === method) throw new Error(`styr-terminal: ${method} failed`)
  }

  write(data: string): void {
    this.check('write')
    if (data.length > 1024 * 1024) throw new Error('styr-terminal: write over 1 MiB')
    this.written += data
    // A cursor-position query gets an answer, as the real engine's would.
    if (data.includes('\x1b[6n')) this.responses += '\x1b[1;1R'
    this.dirty = true
  }

  resize(cols: number, rows: number): void {
    this.check('resize')
    this.cols = cols
    this.rows = rows
    this.dirty = true
  }

  scroll(): void {
    this.check('scroll')
    this.dirty = true
  }

  scrollToBottom(): void {
    this.check('scrollToBottom')
    this.dirty = true
  }

  takeFrame(): EngineFrame | null {
    this.check('takeFrame')
    if (!this.dirty) return null
    this.dirty = false
    return this.frame()
  }

  snapshot(): EngineFrame {
    this.check('snapshot')
    return this.frame()
  }

  takeResponses(): string {
    this.check('takeResponses')
    const responses = this.responses
    this.responses = ''
    return responses
  }

  text(): string {
    this.check('text')
    return this.screenLines().join('\n')
  }

  lines(from: number, to: number): string {
    this.check('lines')
    return this.screenLines().slice(from, to).join('\n')
  }

  reset(): void {
    this.check('reset')
    this.written = ''
    this.dirty = true
  }

  dispose(): void {
    this.disposed = true
  }

  cursorPosition(): { line: number; col: number } {
    this.check('cursorPosition')
    const lines = this.screenLines()
    return { line: lines.length - 1, col: lines.at(-1)!.length }
  }

  markLine(id: string, offset: number): number | null {
    this.check('markLine')
    const line = this.cursorPosition().line + offset
    if (line < 0) return null
    this.marks.set(id, line)
    return line
  }

  markedLines(): { id: string; line: number }[] {
    this.check('markedLines')
    return [...this.marks].map(([id, line]) => ({ id, line }))
  }

  private screenLines(): string[] {
    return this.written.replace(/\r/g, '').split('\n')
  }

  private frame(): EngineFrame {
    const lines = this.screenLines().slice(-this.rows)
    this.seq += 1
    return {
      seq: this.seq,
      full: true,
      cols: this.cols,
      rows: this.rows,
      cursor: { row: Math.max(0, lines.length - 1), col: 0, visible: true, shape: 'block' },
      altScreen: false,
      modes: {
        appCursor: false,
        appKeypad: false,
        bracketedPaste: false,
        focusEvents: false,
        mouse: 'none',
        sgrMouse: false
      },
      historySize: 0,
      displayOffset: 0,
      bell: false,
      lines: lines.map((text, row) => ({
        row,
        wrapped: false,
        runs: text ? [{ text, width: text.length, fg: -1, bg: -1, flags: 0 }] : []
      }))
    }
  }
}

/** A module object shaped like the package's exports. */
export function fakeNativeModule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    API_VERSION: TERMINAL_ENGINE_API_VERSION,
    engineInfo: () => ({
      apiVersion: TERMINAL_ENGINE_API_VERSION,
      packageVersion: '0.1.0-test',
      coreVersion: '0.1.0 (fixture)',
      target: 'aarch64-apple-darwin'
    }),
    TerminalEngine: FakeEngine,
    ...overrides
  }
}
