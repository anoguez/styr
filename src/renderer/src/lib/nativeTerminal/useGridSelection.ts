import { useEffect, useRef, useState, type RefObject } from 'react'
import type { TerminalSelection } from '../../components/TerminalView.js'
import { isEmptySelection, orderedRange, selectionText, type GridSelection } from './selection.js'
import type { ScreenState } from './useNativeEngine.js'

/**
 * The grid's own selection, in buffer lines, so it can reach into the scrollback. `selectionRef`
 * is what the pointer handlers read (they outlive a render); the state is what draws it.
 */
export function useGridSelection({
  sessionId,
  gridRef,
  gridCols,
  onSelectionRef
}: {
  sessionId: string
  gridRef: RefObject<ScreenState | null>
  gridCols: number
  onSelectionRef: RefObject<((selection: TerminalSelection | null) => void) | undefined>
}) {
  const [selection, setSelection] = useState<GridSelection | null>(null)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const hasGridSelection = (): boolean =>
    selectionRef.current !== null && !isEmptySelection(selectionRef.current)
  const clearSelection = (): void => {
    if (!selectionRef.current) return
    selectionRef.current = null
    setSelection(null)
    onSelectionRef.current?.(null)
  }
  // A new width reflows the buffer, so the selected lines are no longer where they were.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => clearSelection(), [gridCols])
  /** The selection's text, read from the engine's buffer so it reaches past the screen. */
  const gridSelectionText = async (picked: GridSelection): Promise<string> => {
    const { start, end } = orderedRange(picked)
    const lines = await window.api.terminal.native.styledLines(sessionId, start.line, end.line + 1)
    return selectionText(picked, lines, gridRef.current?.cols ?? 0)
  }
  return {
    selection,
    setSelection,
    selectionRef,
    hasGridSelection,
    clearSelection,
    gridSelectionText
  }
}
