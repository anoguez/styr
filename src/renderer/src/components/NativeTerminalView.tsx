import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type WheelEvent,
  type ReactNode
} from 'react'
import type {
  EngineFrameLine,
  NativeUnavailableReason,
  ShortcutBindings,
  ThemeSettings
} from '@core/types.js'
import { syntaxFor, type ShellDialect } from '@core/shell.js'
import { terminalTheme } from '../lib/palette.js'
import { clipboardKey, isAppShortcut, multilineSequence } from '../lib/terminalKeys.js'
import { usesControlAsPrimary } from '@core/shortcuts.js'
import { ScreenModel } from '../lib/nativeTerminal/screen.js'
import { encodeKey, pasteSequence } from '../lib/nativeTerminal/keys.js'
import { paletteFromTheme, runStyle, type RunPalette } from '../lib/nativeTerminal/style.js'
import type { TerminalHandle, TerminalSelection } from './TerminalView.js'

const LINE_HEIGHT = 1.25

interface Cell {
  width: number
  height: number
}

/**
 * Styr Terminal's view: draws the frames a native engine in the main process sends, and sends keys
 * to the same PTY xterm.js would. Output is untrusted, so every character goes in as text content —
 * nothing it contains is parsed as markup or turned into an action. Any failure hands the session to
 * `onFallback`, which mounts xterm.js in its place; the PTY is never touched.
 */
export function NativeTerminalView({
  sessionId,
  dialect,
  active,
  theme,
  bindings,
  handle,
  onSelection,
  onFullscreenChange,
  onFallback
}: {
  sessionId: string
  dialect?: ShellDialect
  active: boolean
  theme: ThemeSettings
  bindings: ShortcutBindings
  handle?: MutableRefObject<TerminalHandle | null>
  onSelection?: (selection: TerminalSelection | null) => void
  onFullscreenChange?: (fullscreen: boolean) => void
  onFallback: (reason: NativeUnavailableReason, detail: string) => void
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const model = useRef<ScreenModel | null>(null)
  const [, setVersion] = useState(0)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [cell, setCell] = useState<Cell>({ width: 8, height: 16 })
  const cellRef = useRef(cell)
  const palette = useMemo(() => paletteFromTheme(terminalTheme(theme)), [theme])
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings
  const syntaxRef = useRef(syntaxFor(dialect))
  syntaxRef.current = syntaxFor(dialect)
  const onSelectionRef = useRef(onSelection)
  onSelectionRef.current = onSelection
  const onFullscreenRef = useRef(onFullscreenChange)
  onFullscreenRef.current = onFullscreenChange
  const onFallbackRef = useRef(onFallback)
  onFallbackRef.current = onFallback

  const write = (data: string): void => {
    const screen = model.current?.current
    if (screen && screen.displayOffset > 0) window.api.terminal.native.scroll(sessionId, 'bottom')
    window.api.terminal.write(sessionId, data)
  }

  const fontSizeRef = useRef(theme.terminalFontSize)
  fontSizeRef.current = theme.terminalFontSize
  const pushSizeRef = useRef<(() => void) | null>(null)

  // A font change alters the cell, so the grid is recomputed once the new style has applied.
  useEffect(() => {
    const frame = requestAnimationFrame(() => pushSizeRef.current?.())
    return () => cancelAnimationFrame(frame)
  }, [theme.terminalFont, theme.terminalFontSize])

  useEffect(() => {
    const element = host.current
    if (!element) return
    const screen = new ScreenModel()
    model.current = screen
    let disposed = false
    let attachId: number | null = null
    let frameRequest = 0
    let size = { cols: 0, rows: 0 }
    let fullscreen = false

    const render = (): void => {
      if (frameRequest) return
      frameRequest = requestAnimationFrame(() => {
        frameRequest = 0
        const state = screen.current
        if (state && state.altScreen !== fullscreen) {
          fullscreen = state.altScreen
          onFullscreenRef.current?.(fullscreen)
        }
        setVersion((version) => version + 1)
      })
    }
    const fail = (reason: NativeUnavailableReason, detail: string): void => {
      if (disposed) return
      disposed = true
      onFallbackRef.current(reason, detail)
    }
    // The cell comes from the real font, so the grid matches what the glyphs need. A hidden view
    // measures nothing; it keeps the last cell until it is shown and the observer fires again.
    const measureCell = (): Cell => {
      const box = probe.current?.getBoundingClientRect()
      if (!box || box.width <= 0) return cellRef.current
      const next = { width: box.width / 10, height: fontSizeRef.current * LINE_HEIGHT }
      if (next.width !== cellRef.current.width || next.height !== cellRef.current.height) {
        cellRef.current = next
        setCell(next)
      }
      return next
    }
    const measure = (): { cols: number; rows: number } => {
      const { width, height } = measureCell()
      const box = element.getBoundingClientRect()
      return {
        cols: Math.max(2, Math.floor(box.width / width)),
        rows: Math.max(1, Math.floor(box.height / height))
      }
    }

    const offFrame = window.api.terminal.native.onFrame((event) => {
      if (event.id !== sessionId) return
      // Before the attach reply the engine's id is unknown; the model holds the frame until then.
      if (attachId !== null && event.attachId !== attachId) return
      if (screen.push(event.frame)) render()
    })
    const offFailed = window.api.terminal.native.onFailed((failure) => {
      if (failure.id === sessionId) fail(failure.reason, failure.detail)
    })
    const offExit = window.api.terminal.onExit(({ id, exitCode }) => {
      if (id === sessionId) setExitCode(exitCode)
    })

    size = measure()
    void window.api.terminal.native.attach(sessionId, size.cols, size.rows).then(
      (result) => {
        if (disposed) return
        if (!result.ok) return fail(result.reason, result.detail)
        attachId = result.attachId
        screen.reset(result.frame)
        window.api.terminal.resize(sessionId, size.cols, size.rows)
        render()
      },
      (error: unknown) => fail('init-failed', String(error))
    )

    const pushSize = (): void => {
      const next = measure()
      if (next.cols === size.cols && next.rows === size.rows) return
      size = next
      window.api.terminal.native.resize(sessionId, size.cols, size.rows)
      window.api.terminal.resize(sessionId, size.cols, size.rows)
    }
    pushSizeRef.current = pushSize
    const observer = new ResizeObserver(pushSize)
    observer.observe(element)

    if (handle) {
      handle.current = {
        focus: () => element.focus(),
        // The engine's scrollback is in the main process; synchronously only the screen is known.
        text: () => screen.text(),
        lines: () => ''
      }
    }

    return () => {
      disposed = true
      cancelAnimationFrame(frameRequest)
      offFrame()
      offFailed()
      offExit()
      observer.disconnect()
      pushSizeRef.current = null
      window.api.terminal.native.detach(sessionId)
      if (handle) handle.current = null
      if (fullscreen) onFullscreenRef.current?.(false)
      model.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => host.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [active])

  const state = model.current?.current ?? null

  const selectedText = (): string => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !host.current) return ''
    return host.current.contains(selection.anchorNode) ? selection.toString() : ''
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const native = event.nativeEvent
    const clipboard = clipboardKey(native, selectedText() !== '')
    if (clipboard === 'copy') {
      event.preventDefault()
      void navigator.clipboard.writeText(selectedText())
      window.getSelection()?.removeAllRanges()
      return
    }
    // Left to the browser, whose paste event arrives in onPaste.
    if (clipboard === 'paste') return
    const multiline = multilineSequence(native)
    if (multiline !== null) {
      event.preventDefault()
      write(multiline)
      return
    }
    if (isAppShortcut(native, bindingsRef.current)) return
    const sequence = encodeKey(native, {
      modes: { appCursor: state?.modes.appCursor ?? false },
      altIsMeta: usesControlAsPrimary()
    })
    if (sequence === null) return
    event.preventDefault()
    write(sequence)
  }

  const onPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    event.preventDefault()
    write(pasteSequence(text, state?.modes.bracketedPaste ?? false))
  }

  const wheelRemainder = useRef(0)
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const lines = (event.deltaY + wheelRemainder.current) / cell.height
    const whole = Math.trunc(lines)
    wheelRemainder.current = (lines - whole) * cell.height
    if (whole === 0) return
    if (state?.altScreen) {
      // Without mouse reporting, a full-screen program scrolls with the arrow keys (as in xterm.js).
      const key = whole < 0 ? 'ArrowUp' : 'ArrowDown'
      const sequence = encodeKey(
        { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false },
        { modes: { appCursor: state.modes.appCursor }, altIsMeta: false }
      )
      if (sequence) window.api.terminal.write(sessionId, sequence.repeat(Math.abs(whole)))
      return
    }
    window.api.terminal.native.scroll(sessionId, -whole)
  }

  const onMouseUp = (event: MouseEvent<HTMLDivElement>): void => {
    const text = selectedText()
    if (!text.trim() || !host.current) {
      onSelectionRef.current?.(null)
      return
    }
    const box = host.current.getBoundingClientRect()
    onSelectionRef.current?.({ text, x: event.clientX - box.left, y: event.clientY - box.top })
  }

  const focusReport = (focused: boolean): void => {
    if (state?.modes.focusEvents)
      window.api.terminal.write(sessionId, focused ? '\x1b[I' : '\x1b[O')
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) return
    event.preventDefault()
    const paths = window.api.terminal.pathsForFiles(files)
    if (paths.length > 0) {
      const text = paths.map((path) => syntaxRef.current.quote(path)).join(' ') + ' '
      write(pasteSequence(text, state?.modes.bracketedPaste ?? false))
    }
    host.current?.focus()
  }

  const font: CSSProperties = {
    fontFamily: theme.terminalFont,
    fontSize: theme.terminalFontSize,
    lineHeight: `${cell.height}px`
  }

  return (
    <div
      ref={host}
      hidden={!active}
      tabIndex={0}
      role="log"
      aria-label="Terminal"
      data-terminal-engine="native"
      className="styr-native-terminal relative h-full w-full overflow-hidden whitespace-pre outline-none select-text"
      style={{ ...font, color: palette.foreground, backgroundColor: palette.background }}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onWheel={onWheel}
      onMouseUp={onMouseUp}
      onFocus={() => focusReport(true)}
      onBlur={() => focusReport(false)}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <span ref={probe} aria-hidden className="invisible absolute" style={font}>
        WWWWWWWWWW
      </span>
      {state?.lines.map((line) => (
        <Row key={line.row} line={line} cell={cell} palette={palette} />
      ))}
      {state?.cursor.visible ? (
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={cursorStyle(state.cursor.shape, state.cursor.row, state.cursor.col, cell, palette)}
        />
      ) : null}
      {exitCode !== null ? (
        <div className="text-faint absolute right-2 bottom-1 text-xs">
          process exited with code {exitCode}
        </div>
      ) : null}
    </div>
  )
}

function Row({
  line,
  cell,
  palette
}: {
  line: EngineFrameLine
  cell: Cell
  palette: RunPalette
}): ReactNode {
  return (
    <div style={{ height: cell.height }}>
      {line.runs.map((run, index) => (
        <span
          key={index}
          className="inline-block overflow-hidden align-top"
          style={{ ...runStyle(run, palette), width: run.width * cell.width }}
        >
          {run.text}
        </span>
      ))}
    </div>
  )
}

function cursorStyle(
  shape: 'block' | 'underline' | 'bar',
  row: number,
  col: number,
  cell: Cell,
  palette: RunPalette
): CSSProperties {
  const base: CSSProperties = { left: col * cell.width, top: row * cell.height }
  if (shape === 'bar') return { ...base, width: 2, height: cell.height, background: palette.cursor }
  if (shape === 'underline') {
    return {
      ...base,
      top: (row + 1) * cell.height - 2,
      width: cell.width,
      height: 2,
      background: palette.cursor
    }
  }
  return {
    ...base,
    width: cell.width,
    height: cell.height,
    background: palette.cursor,
    opacity: 0.5
  }
}
