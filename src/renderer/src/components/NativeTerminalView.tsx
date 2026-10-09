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
import { BlockFeed, lineAtOffset, nativeBlockLayout } from '../lib/nativeTerminal/blocks.js'
import { BlockListStore } from '../lib/nativeTerminal/blockList.js'
import { TerminalBlockList } from './TerminalBlockList.js'
import type { BlockActions } from './TerminalBlocks.js'
import { encodeKey, pasteSequence } from '../lib/nativeTerminal/keys.js'
import { paletteFromTheme, runStyle, type RunPalette } from '../lib/nativeTerminal/style.js'
import type { BlockLayout, TerminalHandle, TerminalSelection } from './TerminalView.js'

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
  onBlocks,
  onHoverLine,
  blockActions,
  canRetry = false,
  commandHint = '',
  onBlockListChange,
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
  /** Where the shell's commands sit in the buffer, as `TerminalView` reports them for xterm.js. */
  onBlocks?: (layout: BlockLayout) => void
  /** The buffer line under the pointer, or null when it is outside the terminal. */
  onHoverLine?: (line: number | null) => void
  /** What the block list's buttons do. */
  blockActions?: BlockActions
  canRetry?: boolean
  /** Placeholder for the block list's command input. */
  commandHint?: string
  /** The session started (true) or stopped showing as a block list. */
  onBlockListChange?: (on: boolean) => void
  onFallback: (reason: NativeUnavailableReason, detail: string) => void
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const model = useRef<ScreenModel | null>(null)
  const listRef = useRef<BlockListStore | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
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
  const onBlocksRef = useRef(onBlocks)
  onBlocksRef.current = onBlocks
  const onHoverRef = useRef(onHoverLine)
  onHoverRef.current = onHoverLine
  const onBlockListRef = useRef(onBlockListChange)
  onBlockListRef.current = onBlockListChange

  const write = (data: string): void => {
    const screen = model.current?.current
    if (screen && screen.displayOffset > 0) window.api.terminal.native.scroll(sessionId, 'bottom')
    window.api.terminal.write(sessionId, data)
  }

  const fontSizeRef = useRef(theme.terminalFontSize)
  fontSizeRef.current = theme.terminalFontSize
  const pushSizeRef = useRef<(() => void) | null>(null)
  const renderRef = useRef<(() => void) | null>(null)

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
    const list = new BlockListStore()
    listRef.current = list
    let listShown = false
    let disposed = false
    let attachId: number | null = null
    let frameRequest = 0
    let size = { cols: 0, rows: 0 }
    let fullscreen = false
    const blocks = new BlockFeed()

    const render = (): void => {
      if (frameRequest) return
      frameRequest = requestAnimationFrame(() => {
        frameRequest = 0
        const listed = list.state
        if ((listed !== null) !== listShown) {
          listShown = listed !== null
          onBlockListRef.current?.(listShown)
        }
        // A block list is full-screen only while its running command is on the alternate screen.
        const state = listed ? listed.screen.current : screen.current
        const alternate = Boolean(state?.altScreen && (!listed || listed.active.kind === 'running'))
        if (state && alternate !== fullscreen) {
          fullscreen = alternate
          onFullscreenRef.current?.(fullscreen)
        }
        if (!listed && state) {
          onBlocksRef.current?.(nativeBlockLayout(state, blocks.blocks, cellRef.current.height))
        }
        setVersion((version) => version + 1)
      })
    }
    renderRef.current = render
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
      const moved = event.blocks ? blocks.received(event.attachId, event.blocks) : false
      const changed = event.frame ? screen.push(event.frame) : false
      if (changed || moved) render()
    })
    const offList = window.api.terminal.native.onBlocks((event) => {
      if (event.id === sessionId && list.received(event)) render()
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
        blocks.attached(result.attachId, result.blocks)
        list.attached(result.attachId, result.blockList)
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
        focus: () => (inputRef.current ?? element).focus(),
        // The engine and its scrollback are in the main process.
        text: () => window.api.terminal.native.text(sessionId),
        lines: (from, to) => window.api.terminal.native.lines(sessionId, from, to)
      }
    }

    return () => {
      disposed = true
      cancelAnimationFrame(frameRequest)
      offFrame()
      offList()
      offFailed()
      offExit()
      observer.disconnect()
      pushSizeRef.current = null
      renderRef.current = null
      window.api.terminal.native.detach(sessionId)
      if (handle) handle.current = null
      if (fullscreen) onFullscreenRef.current?.(false)
      if (listShown) onBlockListRef.current?.(false)
      model.current = null
      listRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // The blocks are placed by cell height, so a new cell re-reports them without waiting for output.
  useEffect(() => renderRef.current?.(), [cell])

  const list = listRef.current?.state ?? null
  // A full-screen program in the block list gets the whole panel as a grid.
  const takeover = Boolean(list?.active.kind === 'running' && list.screen.current?.altScreen)
  const prompting = list !== null && list.active.kind === 'prompt'
  /** The screen the program is drawing, whose modes decide how keys are sent. */
  const state = list ? list.screen.current : (model.current?.current ?? null)
  const grid = list ? (takeover ? state : null) : state

  // Typing goes to Styr's input at a prompt and straight to the PTY while a command runs; the
  // input comes and goes with the prompt, so focus follows it.
  const segmentKey = list ? `${list.active.kind}:${list.active.id}` : 'grid'
  const focusRef = useRef<() => void>(() => {})
  focusRef.current = () => {
    if (!host.current) return
    if (prompting && inputRef.current) inputRef.current.focus()
    else if (
      !host.current.contains(document.activeElement) ||
      document.activeElement === document.body
    )
      host.current.focus()
  }
  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => focusRef.current())
    return () => cancelAnimationFrame(frame)
  }, [active, segmentKey])

  const selectedText = (): string => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !host.current) return ''
    return host.current.contains(selection.anchorNode) ? selection.toString() : ''
  }

  const fromInput = (target: EventTarget): boolean => target instanceof HTMLTextAreaElement

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // The command input handles its own keys.
    if (fromInput(event.target)) return
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
    if (prompting) {
      // Focus moves before the key's default action, so the character lands in the input.
      inputRef.current?.focus()
      return
    }
    const sequence = encodeKey(native, {
      modes: { appCursor: state?.modes.appCursor ?? false },
      altIsMeta: usesControlAsPrimary()
    })
    if (sequence === null) return
    event.preventDefault()
    write(sequence)
  }

  /** Puts text into the command input as if typed, so it can still be edited before running. */
  const insertIntoInput = (text: string): void => {
    inputRef.current?.focus()
    document.execCommand('insertText', false, text)
  }

  const onPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    if (fromInput(event.target)) return
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    event.preventDefault()
    if (prompting) return insertIntoInput(text)
    write(pasteSequence(text, state?.modes.bracketedPaste ?? false))
  }

  const wheelRemainder = useRef(0)
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    // The block list scrolls as a page.
    if (list && !takeover) return
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

  const hovered = useRef<number | null>(null)
  const hover = (line: number | null): void => {
    if (line === hovered.current) return
    hovered.current = line
    onHoverRef.current?.(line)
  }
  const onMouseMove = (event: MouseEvent<HTMLDivElement>): void => {
    if (!state || !host.current || list) return
    const offset = event.clientY - host.current.getBoundingClientRect().top
    hover(lineAtOffset(state, offset, cell.height))
  }

  const onMouseUp = (event: MouseEvent<HTMLDivElement>): void => {
    const text = selectedText()
    if (!text.trim() || !host.current) {
      onSelectionRef.current?.(null)
      // A click in the list (not on one of its controls) goes back to typing.
      const target = event.target as HTMLElement
      if (prompting && !target.closest('button, [role="menu"], textarea')) inputRef.current?.focus()
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
      if (prompting) return insertIntoInput(text)
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
      onMouseMove={onMouseMove}
      onMouseLeave={() => hover(null)}
      onFocus={() => focusReport(true)}
      onBlur={() => focusReport(false)}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <span ref={probe} aria-hidden className="invisible absolute" style={font}>
        WWWWWWWWWW
      </span>
      {list && !takeover ? (
        <TerminalBlockList
          state={list}
          look={{ palette, lineHeight: cell.height }}
          font={font}
          inputRef={inputRef}
          hint={commandHint}
          canRetry={canRetry}
          actions={blockActions}
          onSubmit={write}
          onClearBlocks={() => window.api.terminal.native.clearBlocks(sessionId)}
        />
      ) : null}
      {grid?.lines.map((line) => (
        <Row key={line.row} line={line} cell={cell} palette={palette} />
      ))}
      {grid?.cursor.visible ? (
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={cursorStyle(grid.cursor.shape, grid.cursor.row, grid.cursor.col, cell, palette)}
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
