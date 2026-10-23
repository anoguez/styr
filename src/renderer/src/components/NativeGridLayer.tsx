import type { CSSProperties, FormEvent, CompositionEvent, ReactNode, RefObject } from 'react'
import type { EngineFrameLine } from '@core/types.js'
import { viewportTop } from '../lib/nativeTerminal/blocks.js'
import { isOpenableLink } from '../lib/nativeTerminal/links.js'
import { selectionSpans, type GridSelection } from '../lib/nativeTerminal/selection.js'
import { runStyle, type RunPalette } from '../lib/nativeTerminal/style.js'
import type { Cell, ScreenState } from '../lib/nativeTerminal/useNativeEngine.js'

/**
 * What the native view draws for a program's own screen, over its host: the selection, the rows,
 * the hidden input an input method types into, the text being composed, the cursor and the exit
 * code. Everything is text content; nothing here is parsed as markup.
 */
export function NativeGridLayer({
  grid,
  linkedGrid,
  selection,
  cell,
  palette,
  font,
  composition,
  imeRef,
  imeHandlers,
  exitCode
}: {
  grid: ScreenState | null
  linkedGrid: EngineFrameLine[]
  selection: GridSelection | null
  cell: Cell
  palette: RunPalette
  font: CSSProperties
  composition: string
  imeRef: RefObject<HTMLTextAreaElement | null>
  imeHandlers: {
    onCompositionStart: () => void
    onCompositionUpdate: (event: CompositionEvent<HTMLTextAreaElement>) => void
    onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => void
    onInput: (event: FormEvent<HTMLTextAreaElement>) => void
  }
  exitCode: number | null
}): ReactNode {
  return (
    <>
      {grid && selection
        ? selectionSpans(selection, viewportTop(grid), grid.rows, grid.cols, grid.lines).map(
            (span) => (
              <div
                key={span.row}
                aria-hidden
                className="pointer-events-none absolute"
                style={{
                  top: span.row * cell.height,
                  left: span.from * cell.width,
                  width: (span.to - span.from) * cell.width,
                  height: cell.height,
                  background: palette.selection
                }}
              />
            )
          )
        : null}
      {linkedGrid.map((line) => (
        <Row key={line.row} line={line} cell={cell} palette={palette} />
      ))}
      {grid ? (
        <textarea
          ref={imeRef}
          aria-label="Terminal input"
          tabIndex={-1}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="pointer-events-none absolute resize-none overflow-hidden border-0 bg-transparent p-0 opacity-0"
          // At the cursor, so an input method's candidate window opens beside it.
          style={{
            ...font,
            left: grid.cursor.col * cell.width,
            top: grid.cursor.row * cell.height,
            width: cell.width,
            height: cell.height,
            outline: 'none'
          }}
          {...imeHandlers}
        />
      ) : null}
      {grid && composition ? (
        <span
          aria-hidden
          className="pointer-events-none absolute z-10 underline"
          style={{
            left: grid.cursor.col * cell.width,
            top: grid.cursor.row * cell.height,
            height: cell.height,
            color: palette.foreground,
            background: palette.background
          }}
        >
          {composition}
        </span>
      ) : null}
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
    </>
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
      {line.runs.map((run, index) => {
        const link = isOpenableLink(run.link) ? run.link : undefined
        return (
          <span
            key={index}
            className={`inline-block overflow-hidden align-top ${link ? 'cursor-pointer hover:underline' : ''}`}
            style={{ ...runStyle(run, palette), width: run.width * cell.width }}
            // An OSC 8 link's text need not say where it goes; the address is shown on hover.
            title={link}
          >
            {run.text}
          </span>
        )
      })}
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
