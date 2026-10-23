import {
  useEffect,
  useRef,
  type Dispatch,
  type MouseEvent,
  type RefObject,
  type SetStateAction,
  type WheelEvent
} from 'react'
import type { EngineFrameLine } from '@core/types.js'
import { usesControlAsPrimary } from '@core/shortcuts.js'
import { lineAtOffset, viewportTop } from './blocks.js'
import { encodeKey } from './keys.js'
import {
  cellAt,
  encodeMouse,
  mouseButton,
  reportsMouse,
  type MouseButton,
  type MouseReport
} from './mouse.js'
import { isOpenableLink } from './links.js'
import { rowCells } from './cells.js'
import { isEmptySelection, type GridSelection } from './selection.js'
import { startSelection, wheelLines } from './pointerMath.js'
import type { BlockListState } from './blockList.js'
import type { TerminalSelection } from '../../components/TerminalView.js'
import type { Cell, ScreenState } from './useNativeEngine.js'

/**
 * The mouse in the native view: the wheel (scrolls, or reports to the program), pointer reports for
 * programs that take the mouse, grid selection by drag, and the click that opens a link.
 */
export function useGridPointer({
  sessionId,
  host,
  inputRef,
  imeRef,
  list,
  takeover,
  agentMode,
  typing,
  grid,
  state,
  cell,
  cellRef,
  gridRef,
  linkedRef,
  selectionRef,
  setSelection,
  clearSelection,
  gridSelectionText,
  selectedText,
  onSelectionRef,
  onHoverRef
}: {
  sessionId: string
  host: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLTextAreaElement | null>
  imeRef: RefObject<HTMLTextAreaElement | null>
  list: BlockListState | null
  takeover: boolean
  agentMode: boolean
  typing: boolean
  grid: ScreenState | null
  state: ScreenState | null
  cell: Cell
  cellRef: RefObject<Cell>
  gridRef: RefObject<ScreenState | null>
  linkedRef: RefObject<EngineFrameLine[]>
  selectionRef: RefObject<GridSelection | null>
  setSelection: Dispatch<SetStateAction<GridSelection | null>>
  clearSelection: () => void
  gridSelectionText: (picked: GridSelection) => Promise<string>
  selectedText: () => string
  onSelectionRef: RefObject<((selection: TerminalSelection | null) => void) | undefined>
  onHoverRef: RefObject<((line: number | null) => void) | undefined>
}) {
  const wheelRemainder = useRef(0)
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    // The block list and the agent view scroll as a page.
    if (list && (!takeover || agentMode)) return
    const { whole, remainder } = wheelLines(event.deltaY, wheelRemainder.current, cell.height)
    wheelRemainder.current = remainder
    if (whole === 0) return
    if (state && reportsMouse(state.modes, event.shiftKey)) {
      const report: MouseReport = {
        kind: 'press',
        button: whole < 0 ? 'wheelUp' : 'wheelDown',
        ...pointerCell(event),
        shiftKey: false,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey
      }
      const sequence = encodeMouse(report, state.modes)
      if (sequence) window.api.terminal.write(sessionId, sequence.repeat(Math.abs(whole)))
      return
    }
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
  const focusGrid = (): void => (imeRef.current ?? host.current)?.focus()

  /** The grid cell under the pointer, kept on the screen. */
  const pointerCell = (event: {
    clientX: number
    clientY: number
  }): { col: number; row: number } => {
    const box = host.current?.getBoundingClientRect()
    const screen = gridRef.current
    if (!box || !screen) return { col: 0, row: 0 }
    return cellAt(event.clientX - box.left, event.clientY - box.top, cellRef.current, screen)
  }

  /** The web link in a grid cell, if there is one. */
  const linkAt = (point: { col: number; row: number }): string | undefined => {
    const row = linkedRef.current[point.row]
    const link = row ? rowCells(row)[point.col]?.link : undefined
    return isOpenableLink(link) ? link : undefined
  }

  const sendMouse = (report: MouseReport): void => {
    const modes = gridRef.current?.modes
    const sequence = modes ? encodeMouse(report, modes) : null
    if (sequence) window.api.terminal.write(sessionId, sequence)
  }

  // A press in the grid is followed to its release wherever the pointer goes.
  const stopDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => stopDrag.current?.(), [])
  const follow = (
    move: (event: globalThis.MouseEvent) => void,
    up: (event: globalThis.MouseEvent) => void
  ): void => {
    stopDrag.current?.()
    const onUp = (event: globalThis.MouseEvent): void => {
      stop()
      up(event)
    }
    const stop = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', onUp)
      stopDrag.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', onUp)
    stopDrag.current = stop
  }

  const onMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    const screen = gridRef.current
    if (!screen || !host.current) return
    const point = pointerCell(event)
    const link = linkAt(point)
    // ⌘-click (Ctrl elsewhere) opens a link even while the program takes the mouse.
    const primary = usesControlAsPrimary() ? event.ctrlKey : event.metaKey
    const button = mouseButton(event.button)
    const modifiers = { shiftKey: false, altKey: event.altKey, ctrlKey: event.ctrlKey }

    if (button && reportsMouse(screen.modes, event.shiftKey) && !(primary && link)) {
      event.preventDefault()
      focusGrid()
      clearSelection()
      sendMouse({ kind: 'press', button, ...point, ...modifiers })
      let last = point
      follow(
        (move) => {
          const next = pointerCell(move)
          if (next.col === last.col && next.row === last.row) return
          last = next
          sendMouse({ kind: 'move', button, ...next, ...modifiers })
        },
        (up) => sendMouse({ kind: 'release', button, ...pointerCell(up), ...modifiers })
      )
      return
    }
    if (event.button !== 0) return
    event.preventDefault()
    focusGrid()
    const at = { line: viewportTop(screen) + point.row, col: point.col }
    const extend = event.shiftKey && selectionRef.current
    const started = startSelection(at, event.detail, event.shiftKey, selectionRef.current)
    selectionRef.current = started
    setSelection(started)
    onSelectionRef.current?.(null)
    follow(
      (move) => {
        const current = selectionRef.current
        const box = host.current?.getBoundingClientRect()
        const live = gridRef.current
        if (!current || !box || !live) return
        // Past the top or bottom edge the view scrolls, so a selection can reach into history.
        if (move.clientY < box.top) window.api.terminal.native.scroll(sessionId, 1)
        else if (move.clientY > box.bottom) window.api.terminal.native.scroll(sessionId, -1)
        const next = pointerCell(move)
        const head = { line: viewportTop(live) + next.row, col: next.col }
        if (head.line === current.head.line && head.col === current.head.col) return
        const moved = { ...current, head }
        selectionRef.current = moved
        setSelection(moved)
      },
      (up) => {
        const current = selectionRef.current
        if (!current || isEmptySelection(current)) {
          clearSelection()
          // A click, not a drag: the explicit gesture that opens a link.
          if (link && !extend) void window.api.terminal.openLink(link)
          return
        }
        const box = host.current?.getBoundingClientRect()
        void gridSelectionText(current).then((text) => {
          if (selectionRef.current !== current || !text.trim() || !box) return
          onSelectionRef.current?.({ text, x: up.clientX - box.left, y: up.clientY - box.top })
        })
      }
    )
  }

  const hoverCell = useRef<{ col: number; row: number } | null>(null)
  const onMouseMove = (event: MouseEvent<HTMLDivElement>): void => {
    if (!state || !host.current || list) return
    const offset = event.clientY - host.current.getBoundingClientRect().top
    hover(lineAtOffset(state, offset, cell.height))
    // Any-motion tracking (1003) wants the pointer even with no button down.
    if (state.modes.mouse === 'motion' && !stopDrag.current && !event.shiftKey) {
      const point = pointerCell(event)
      const last = hoverCell.current
      if (last && last.col === point.col && last.row === point.row) return
      hoverCell.current = point
      const button: MouseButton = 'none'
      sendMouse({ kind: 'move', button, ...point, shiftKey: false, altKey: false, ctrlKey: false })
    }
  }

  const onMouseUp = (event: MouseEvent<HTMLDivElement>): void => {
    // The grid follows its own presses (`onMouseDown`).
    if (grid) return
    const text = selectedText()
    if (!text.trim() || !host.current) {
      onSelectionRef.current?.(null)
      // A click in the list (not on one of its controls) goes back to typing.
      const target = event.target as HTMLElement
      if (typing && !target.closest('button, [role="menu"], textarea')) inputRef.current?.focus()
      return
    }
    const box = host.current.getBoundingClientRect()
    onSelectionRef.current?.({ text, x: event.clientX - box.left, y: event.clientY - box.top })
  }

  const onMouseLeave = (): void => {
    hover(null)
    hoverCell.current = null
  }

  return { onWheel, onMouseDown, onMouseMove, onMouseUp, onMouseLeave }
}
