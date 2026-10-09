import { useCallback, useEffect, useRef, useState } from 'react'

const MIN_TERMINAL_HEIGHT = 140
const MIN_BOARD_HEIGHT = 220
const TERMINAL_OPEN_RATIO = 0.45

/** The panel height for a pointer at `pointerY`: never below its floor, never squeezing the board. */
export function clampTerminalHeight(pointerY: number, windowHeight: number): number {
  const ceiling = Math.max(MIN_TERMINAL_HEIGHT, windowHeight - MIN_BOARD_HEIGHT)
  return Math.min(Math.max(windowHeight - pointerY, MIN_TERMINAL_HEIGHT), ceiling)
}

function preferredTerminalHeight(): number {
  return Math.round(window.innerHeight * TERMINAL_OPEN_RATIO)
}

/**
 * The terminal panel's height, dragged by its top edge. Opening the panel resets it to a share of
 * the window until the user has resized it by hand, after which their height sticks.
 */
export function useTerminalHeight(terminalOpen: boolean): {
  height: number
  startResize: () => void
} {
  const [height, setHeight] = useState(preferredTerminalHeight)
  const dragging = useRef(false)
  const manuallyResized = useRef(false)

  useEffect(() => {
    if (terminalOpen && !manuallyResized.current) setHeight(preferredTerminalHeight())
  }, [terminalOpen])

  useEffect(() => {
    function onMove(event: MouseEvent): void {
      if (!dragging.current) return
      manuallyResized.current = true
      setHeight(clampTerminalHeight(event.clientY, window.innerHeight))
    }
    function onUp(): void {
      dragging.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const startResize = useCallback(() => {
    dragging.current = true
  }, [])
  return { height, startResize }
}
