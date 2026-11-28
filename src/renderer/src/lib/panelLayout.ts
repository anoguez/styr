/**
 * Where the terminal panel and the agents sidebar sit, and how big they are. Pure: the hook that
 * remembers it per workspace is `hooks/usePanelLayout.ts`, the views are in `App` and
 * `components/PanelGrid.tsx`.
 *
 * The two panels nest, as in VS Code: one is `outer` and spans its whole edge, the other docks
 * against the board alone. The panel moved last goes inside, so it takes the room that is left
 * (the terminal on the left at full height, then the agents moved to the bottom span only the
 * width beside it). The views draw it as one CSS grid (`panelGrid`), so neither the nesting nor
 * the edge changes the DOM, and moving the terminal never remounts it.
 */

export type Dock = 'left' | 'right' | 'top' | 'bottom'
export type PanelId = 'terminal' | 'agents'

export const DOCKS: readonly Dock[] = ['left', 'right', 'top', 'bottom']

export interface PanelPlacement {
  dock: Dock
  /** Pixels along the dock's axis (width at a side, height at the top or bottom); null = default. */
  size: number | null
}

export interface PanelLayout {
  terminal: PanelPlacement
  agents: PanelPlacement
  /** The panel that spans its whole edge; the other docks inside it, against the board. */
  outer: PanelId
}

export const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  terminal: { dock: 'bottom', size: null },
  agents: { dock: 'right', size: null },
  outer: 'agents'
}

export const PANELS: readonly PanelId[] = ['terminal', 'agents']

export function otherPanel(panel: PanelId): PanelId {
  return panel === 'terminal' ? 'agents' : 'terminal'
}

/** The width of the resize handle between a panel and what it docks against. */
export const HANDLE_SIZE = 4

export const PANEL_LABELS: Record<PanelId, string> = {
  terminal: 'terminal',
  agents: 'agents sidebar'
}

export const DOCK_LABELS: Record<Dock, string> = {
  left: 'left',
  right: 'right',
  top: 'top',
  bottom: 'bottom'
}

/** The smallest a panel gets, and the least room it must leave for what it docks against. */
export const MIN_PANEL_SIZE: Record<PanelId, number> = { terminal: 140, agents: 200 }
export const MIN_CONTENT_SIZE = 220

/** A side dock lays out in a row, so its size is a width. */
export function isSideDock(dock: Dock): boolean {
  return dock === 'left' || dock === 'right'
}

/**
 * The size a panel opens at before it has been resized: the terminal takes a share of the room it
 * docks into, the sidebar a fixed sidebar width (or a short strip at the top or bottom).
 */
export function defaultPanelSize(panel: PanelId, dock: Dock, room: number): number {
  if (panel === 'terminal') return Math.round(room * 0.45)
  return isSideDock(dock) ? 288 : 220
}

/** Keeps a panel between its floor and the size that would squeeze what it docks against. */
export function clampPanelSize(panel: PanelId, size: number, room: number): number {
  const floor = MIN_PANEL_SIZE[panel]
  const ceiling = Math.max(floor, room - MIN_CONTENT_SIZE)
  return Math.round(Math.min(Math.max(size, floor), ceiling))
}

/** The size to draw: the saved one, or the default, clamped to the room there is now. */
export function panelSizeFor(placement: PanelPlacement, panel: PanelId, room: number): number {
  const size = placement.size ?? defaultPanelSize(panel, placement.dock, room)
  return clampPanelSize(panel, size, room)
}

/**
 * The size while its edge is dragged: `delta` is how far the pointer moved along the axis since
 * the drag began (positive = right or down). A panel at the bottom or right grows as its edge moves
 * back towards the content; one at the top or left grows as it moves away.
 */
export function resizedPanelSize(
  panel: PanelId,
  dock: Dock,
  startSize: number,
  delta: number,
  room: number
): number {
  const grows = dock === 'bottom' || dock === 'right' ? -delta : delta
  return clampPanelSize(panel, startSize + grows, room)
}

/**
 * Moves a panel to another edge, where it docks inside the other panel: it takes the room that is
 * left rather than pushing the panel already placed. Its size carries over only when the axis
 * stays the same: a height makes no sense as a width, so a move from the bottom to a side starts
 * at the default.
 */
export function movePanel(layout: PanelLayout, panel: PanelId, dock: Dock): PanelLayout {
  const current = layout[panel]
  if (current.dock === dock) return layout
  const size = isSideDock(current.dock) === isSideDock(dock) ? current.size : null
  return { ...layout, [panel]: { dock, size }, outer: otherPanel(panel) }
}

/** Sets a panel's size; null goes back to the default. */
export function resizePanel(layout: PanelLayout, panel: PanelId, size: number | null): PanelLayout {
  if (layout[panel].size === size) return layout
  return { ...layout, [panel]: { ...layout[panel], size } }
}

/**
 * The edge a drop at (`x`, `y`) inside a `width` × `height` area picks: the nearest edge, measured
 * as a share of the area so a wide window does not favour top and bottom.
 */
export function dropDockAt(x: number, y: number, width: number, height: number): Dock {
  const share = {
    left: x / Math.max(width, 1),
    right: 1 - x / Math.max(width, 1),
    top: y / Math.max(height, 1),
    bottom: 1 - y / Math.max(height, 1)
  }
  return DOCKS.reduce((best, dock) => (share[dock] < share[best] ? dock : best))
}

/** The edge of a panel that faces the content, where its border goes, and its handle's cursor. */
export function dockEdge(dock: Dock): { border: string; cursor: string } {
  switch (dock) {
    case 'left':
      return { border: 'border-r', cursor: 'cursor-col-resize' }
    case 'right':
      return { border: 'border-l', cursor: 'cursor-col-resize' }
    case 'top':
      return { border: 'border-b', cursor: 'cursor-row-resize' }
    case 'bottom':
      return { border: 'border-t', cursor: 'cursor-row-resize' }
  }
}

/** Whether each panel is showing, and the terminal's expanded state (it fills, the board hides). */
export interface PanelVisibility {
  open: Record<PanelId, boolean>
  terminalFills: boolean
}

/**
 * Each panel's drawn size and the room it docks into, for a container of `width` × `height`. The
 * outer panel docks into the whole container; the inner one into what the outer leaves on its
 * axis. `live` overrides a saved size while its edge is being dragged.
 */
export function resolvePanelSizes(
  layout: PanelLayout,
  visibility: PanelVisibility,
  container: { width: number; height: number },
  live: Partial<Record<PanelId, number>> = {}
): Record<PanelId, { size: number; room: number }> {
  const along = (dock: Dock): number => (isSideDock(dock) ? container.width : container.height)
  const outer = layout.outer
  const inner = otherPanel(outer)
  const outerRoom = along(layout[outer].dock)
  const outerSize = live[outer] ?? panelSizeFor(layout[outer], outer, outerRoom)
  const sameAxis = isSideDock(layout[outer].dock) === isSideDock(layout[inner].dock)
  const innerRoom =
    along(layout[inner].dock) - (sameAxis && visibility.open[outer] ? outerSize + HANDLE_SIZE : 0)
  const innerSize = live[inner] ?? panelSizeFor(layout[inner], inner, innerRoom)
  return {
    [outer]: { size: outerSize, room: outerRoom },
    [inner]: { size: innerSize, room: innerRoom }
  } as Record<PanelId, { size: number; room: number }>
}

/** A CSS grid for the board and both panels: `grid-template-areas` and the track sizes. */
export interface PanelGridTemplate {
  areas: string
  columns: string
  rows: string
}

/** The grid area of a panel's resize handle. */
export const handleArea = (panel: PanelId): string => `${panel}-handle`

/**
 * The grid that lays out the board and the panels: start from the board alone, dock the inner
 * panel against it, then the outer panel against both, each adding a handle track and a panel
 * track on its edge. A closed panel keeps its tracks at zero, so the areas never change shape.
 */
export function panelGrid(
  layout: PanelLayout,
  visibility: PanelVisibility,
  sizes: Record<PanelId, { size: number }>
): PanelGridTemplate {
  let cells: string[][] = [['board']]
  const fills = visibility.open.terminal && visibility.terminalFills
  // An expanded terminal hides the board: its track on the terminal's axis goes to zero.
  const terminalSide = isSideDock(layout.terminal.dock)
  let columns = [fills && terminalSide ? '0px' : 'minmax(0,1fr)']
  let rows = [fills && !terminalSide ? '0px' : 'minmax(0,1fr)']
  for (const panel of [otherPanel(layout.outer), layout.outer]) {
    const { dock } = layout[panel]
    const open = visibility.open[panel]
    const fill = panel === 'terminal' && fills
    const track = !open ? '0px' : fill ? 'minmax(0,1fr)' : `${sizes[panel].size}px`
    const handle = open && !fill ? `${HANDLE_SIZE}px` : '0px'
    const width = cells[0]?.length ?? 1
    const across = (name: string): string[] => Array.from({ length: width }, () => name)
    switch (dock) {
      case 'left':
        cells = cells.map((row) => [panel, handleArea(panel), ...row])
        columns = [track, handle, ...columns]
        break
      case 'right':
        cells = cells.map((row) => [...row, handleArea(panel), panel])
        columns = [...columns, handle, track]
        break
      case 'top':
        cells = [across(panel), across(handleArea(panel)), ...cells]
        rows = [track, handle, ...rows]
        break
      case 'bottom':
        cells = [...cells, across(handleArea(panel)), across(panel)]
        rows = [...rows, handle, track]
        break
    }
  }
  return {
    areas: cells.map((row) => `"${row.join(' ')}"`).join(' '),
    columns: columns.join(' '),
    rows: rows.join(' ')
  }
}

function isDock(value: unknown): value is Dock {
  return typeof value === 'string' && (DOCKS as readonly string[]).includes(value)
}

function parsePlacement(raw: unknown, fallback: PanelPlacement): PanelPlacement {
  if (!raw || typeof raw !== 'object') return fallback
  const { dock, size } = raw as { dock?: unknown; size?: unknown }
  if (!isDock(dock)) return fallback
  const validSize = typeof size === 'number' && Number.isFinite(size) && size > 0
  return { dock, size: validSize ? Math.round(size) : null }
}

/** Reads a saved layout, keeping what is valid of it and defaulting the rest. */
export function parsePanelLayout(raw: unknown): PanelLayout {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    terminal: parsePlacement(value.terminal, DEFAULT_PANEL_LAYOUT.terminal),
    agents: parsePlacement(value.agents, DEFAULT_PANEL_LAYOUT.agents),
    outer: value.outer === 'terminal' ? 'terminal' : 'agents'
  }
}
