import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import type { NativeUnavailableReason, ThemeSettings } from '@core/types.js'
import { terminalTheme } from '../palette.js'
import { onSessionExit } from '../terminalEvents.js'
import type { BlockLayout, TerminalHandle } from '../../components/TerminalView.js'
import { ScreenModel } from './screen.js'
import { BlockFeed, nativeBlockLayout } from './blocks.js'
import { BlockListStore } from './blockList.js'
import { paletteFromTheme } from './style.js'

const LINE_HEIGHT = 1.25
/**
 * Pixels the block list takes from the width before output starts: its padding, a block's padding
 * and the output's indent under the command, and the scrollbar. Programs are told the columns that
 * fit after it, so their lines wrap where they will be shown.
 */
const LIST_INSET = 56

export interface Cell {
  width: number
  height: number
}

/** A screen's state with every row filled in, as the model hands it out. */
export type ScreenState = NonNullable<ScreenModel['current']>

/**
 * The bridge to the native engine in the main process: attaches the session, keeps the screen and
 * block list models fed by its frames, measures the cell and tells the engine and the PTY the size
 * that fits, and reports full-screen and block-list changes. The attach lasts as long as
 * `sessionId`; a failure of any kind is handed to `onFallback`.
 */
export function useNativeEngine({
  sessionId,
  theme,
  host,
  probe,
  inputRef,
  imeRef,
  handle,
  onFullscreenChange,
  onBlocks,
  onBlockListChange,
  onFallback
}: {
  sessionId: string
  theme: ThemeSettings
  host: RefObject<HTMLDivElement | null>
  /** A span of ten wide characters, in the terminal's font, that the cell is measured from. */
  probe: RefObject<HTMLSpanElement | null>
  inputRef: RefObject<HTMLTextAreaElement | null>
  imeRef: RefObject<HTMLTextAreaElement | null>
  handle?: MutableRefObject<TerminalHandle | null>
  onFullscreenChange?: (fullscreen: boolean) => void
  onBlocks?: (layout: BlockLayout) => void
  onBlockListChange?: (on: boolean) => void
  onFallback: (reason: NativeUnavailableReason, detail: string) => void
}): {
  model: RefObject<ScreenModel | null>
  listRef: RefObject<BlockListStore | null>
  cell: Cell
  cellRef: RefObject<Cell>
  exitCode: number | null
  palette: ReturnType<typeof paletteFromTheme>
  look: { palette: ReturnType<typeof paletteFromTheme>; lineHeight: number }
  /** Types into the PTY, first returning the view to the bottom if it was scrolled up. */
  write: (data: string) => void
} {
  const model = useRef<ScreenModel | null>(null)
  const listRef = useRef<BlockListStore | null>(null)
  const [, setVersion] = useState(0)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [cell, setCell] = useState<Cell>({ width: 8, height: 16 })
  const cellRef = useRef(cell)
  const palette = useMemo(() => paletteFromTheme(terminalTheme(theme)), [theme])
  // One object while neither changes, so memoised blocks and history chunks are not redrawn.
  const look = useMemo(() => ({ palette, lineHeight: cell.height }), [palette, cell.height])
  const onFullscreenRef = useRef(onFullscreenChange)
  onFullscreenRef.current = onFullscreenChange
  const onFallbackRef = useRef(onFallback)
  onFallbackRef.current = onFallback
  const onBlocksRef = useRef(onBlocks)
  onBlocksRef.current = onBlocks
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
          pushSize()
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
      const inset = listShown ? LIST_INSET : 0
      return {
        cols: Math.max(2, Math.floor((box.width - inset) / width)),
        rows: Math.max(1, Math.floor(box.height / height))
      }
    }

    const offFrame = window.api.terminal.native.onFrame((event) => {
      if (event.id !== sessionId) return
      // Acknowledged on arrival, whatever it is for: the host sends nothing more until it is.
      window.api.terminal.native.received(sessionId, event.attachId)
      // Before the attach reply the engine's id is unknown; the model holds the frame until then.
      if (attachId !== null && event.attachId !== attachId) return
      const moved = event.blocks ? blocks.received(event.attachId, event.blocks) : false
      const changed = event.frame ? screen.push(event.frame) : false
      if (changed || moved) render()
    })
    const offList = window.api.terminal.native.onBlocks((event) => {
      if (event.id !== sessionId) return
      window.api.terminal.native.received(sessionId, event.attachId)
      if (list.received(event)) render()
    })
    const offFailed = window.api.terminal.native.onFailed((failure) => {
      if (failure.id === sessionId) fail(failure.reason, failure.detail)
    })
    const offExit = onSessionExit(sessionId, ({ exitCode }) => setExitCode(exitCode))

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
        focus: () => (inputRef.current ?? imeRef.current ?? element).focus(),
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

  return { model, listRef, cell, cellRef, exitCode, palette, look, write }
}
