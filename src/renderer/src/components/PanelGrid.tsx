import {
  useCallback,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject
} from 'react'
import {
  DOCKS,
  DOCK_LABELS,
  PANEL_LABELS,
  dockEdge,
  dropDockAt,
  handleArea,
  isSideDock,
  panelGrid,
  resizedPanelSize,
  resolvePanelSizes,
  type Dock,
  type PanelId,
  type PanelLayout
} from '../lib/panelLayout.js'
import { ActionsMenu } from './TerminalMenu.js'

/** The element's size, kept current by a resize observer. */
function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height }
      )
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}

/**
 * The board and both panels, laid out as one CSS grid from the layout (`panelGrid`). The DOM order
 * is fixed — board, terminal handle, terminal, agents handle, agents — and only the grid template
 * changes with the edges and the nesting, so moving a panel never remounts it (a remounted terminal
 * loses its scrollback). `overlay` is drawn over the whole area (the drop target of a panel drag).
 */
export function PanelGrid({
  areaRef,
  layout,
  open,
  terminalFills,
  onResize,
  board,
  terminal,
  agents,
  overlay
}: {
  areaRef: RefObject<HTMLDivElement | null>
  layout: PanelLayout
  open: Record<PanelId, boolean>
  /** The expanded terminal: it takes the board's room. */
  terminalFills: boolean
  /** The size the user dragged to, once the drag ends; null (a double-click) is the default. */
  onResize: (panel: PanelId, size: number | null) => void
  board: ReactNode
  terminal: ReactNode
  agents: ReactNode
  overlay?: ReactNode
}): ReactNode {
  const room = useElementSize(areaRef)
  const visibility = { open, terminalFills }
  // While dragging, the size lives here and is saved once on release, not on every frame.
  const [live, setLive] = useState<Partial<Record<PanelId, number>>>({})
  const sizes = resolvePanelSizes(layout, visibility, room, live)
  const grid = panelGrid(layout, visibility, sizes)

  const startResize = (panel: PanelId, event: ReactPointerEvent): void => {
    event.preventDefault()
    const { dock } = layout[panel]
    const side = isSideDock(dock)
    const start = side ? event.clientX : event.clientY
    const { size: startSize, room: panelRoom } = sizes[panel]
    let latest = startSize
    const previousCursor = document.body.style.cursor
    document.body.style.cursor = side ? 'col-resize' : 'row-resize'
    const onMove = (move: PointerEvent): void => {
      const delta = (side ? move.clientX : move.clientY) - start
      latest = resizedPanelSize(panel, dock, startSize, delta, panelRoom)
      setLive({ [panel]: latest })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = previousCursor
      setLive({})
      if (latest !== startSize) onResize(panel, latest)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const handle = (panel: PanelId): ReactNode => {
    if (!open[panel] || (panel === 'terminal' && terminalFills)) return null
    const side = isSideDock(layout[panel].dock)
    return (
      <div
        role="separator"
        aria-orientation={side ? 'vertical' : 'horizontal'}
        aria-label={`Resize the ${PANEL_LABELS[panel]}`}
        style={{ gridArea: handleArea(panel) }}
        className={`bg-edge/60 hover:bg-accent/60 ${dockEdge(layout[panel].dock).cursor}`}
        onPointerDown={(event) => startResize(panel, event)}
        onDoubleClick={() => onResize(panel, null)}
      />
    )
  }
  const slot = (panel: PanelId, children: ReactNode): ReactNode =>
    open[panel] ? (
      <div
        style={{ gridArea: panel }}
        className={`flex min-h-0 min-w-0 flex-col overflow-hidden border-edge-strong ${dockEdge(layout[panel].dock).border}`}
      >
        {children}
      </div>
    ) : null

  return (
    <div
      ref={areaRef}
      className="relative grid min-h-0 flex-1"
      style={{
        gridTemplateAreas: grid.areas,
        gridTemplateColumns: grid.columns,
        gridTemplateRows: grid.rows
      }}
    >
      <div
        style={{ gridArea: 'board' }}
        className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        hidden={open.terminal && terminalFills}
      >
        {board}
      </div>
      {handle('terminal')}
      {slot('terminal', terminal)}
      {handle('agents')}
      {slot('agents', agents)}
      {overlay}
    </div>
  )
}

/** A panel being dragged, and the edge it would land on. */
export interface PanelDrag {
  panel: PanelId
  dock: Dock
}

/** The menu of edges, opened by right-clicking a panel's header. */
export interface PanelMenuRequest {
  panel: PanelId
  x: number
  y: number
}

/** Presses on these start nothing: they are the header's own controls (dnd-kit tabs included). */
const CONTROLS = 'button, a, input, textarea, select, [role="button"], [role="tab"], [role="menu"]'

function onControl(event: { target: EventTarget }): boolean {
  return event.target instanceof Element && event.target.closest(CONTROLS) !== null
}

/** What a panel's header spreads on itself to be dragged and right-clicked. */
export interface PanelHeaderProps {
  onPointerDown: (event: ReactPointerEvent) => void
  onContextMenu: (event: ReactMouseEvent) => void
}

export interface PanelMove {
  drag: PanelDrag | null
  menu: PanelMenuRequest | null
  closeMenu: () => void
  /** Handlers for a panel's header: drag it from anywhere but its controls, right-click for the menu. */
  headerProps: (panel: PanelId) => PanelHeaderProps
}

/**
 * Moving a panel, as in VS Code: drag its header to another edge of `area`, or right-click it and
 * pick an edge. Escape cancels a drag.
 */
export function usePanelMove(
  area: RefObject<HTMLElement | null>,
  onDrop: (panel: PanelId, dock: Dock) => void
): PanelMove {
  const [drag, setDrag] = useState<PanelDrag | null>(null)
  const [menu, setMenu] = useState<PanelMenuRequest | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  const begin = useCallback(
    (panel: PanelId, event: ReactPointerEvent) => {
      if (event.button !== 0) return
      const startX = event.clientX
      const startY = event.clientY
      let target: Dock | null = null
      const previousCursor = document.body.style.cursor
      const previousSelect = document.body.style.userSelect
      const dockAt = (x: number, y: number): Dock | null => {
        const rect = area.current?.getBoundingClientRect()
        if (!rect) return null
        return dropDockAt(x - rect.left, y - rect.top, rect.width, rect.height)
      }
      const finish = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('keydown', onKey, true)
        document.body.style.cursor = previousCursor
        document.body.style.userSelect = previousSelect
        setDrag(null)
      }
      const onMove = (move: PointerEvent): void => {
        if (target === null && Math.hypot(move.clientX - startX, move.clientY - startY) < 5) return
        target = dockAt(move.clientX, move.clientY)
        document.body.style.cursor = 'grabbing'
        document.body.style.userSelect = 'none'
        window.getSelection()?.removeAllRanges()
        if (target) setDrag({ panel, dock: target })
      }
      const onUp = (): void => {
        const dropped = target
        finish()
        if (dropped) onDrop(panel, dropped)
      }
      const onKey = (key: KeyboardEvent): void => {
        if (key.key !== 'Escape') return
        key.stopPropagation()
        target = null
        finish()
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('keydown', onKey, true)
    },
    [area, onDrop]
  )

  const headerProps = useCallback(
    (panel: PanelId) => ({
      onPointerDown: (event: ReactPointerEvent) => {
        if (!onControl(event)) begin(panel, event)
      },
      onContextMenu: (event: ReactMouseEvent) => {
        // A tab's own menu (it prevents the default) wins over the panel's.
        if (event.defaultPrevented || onControl(event)) return
        event.preventDefault()
        setMenu({ panel, x: event.clientX, y: event.clientY })
      }
    }),
    [begin]
  )

  return { drag, menu, closeMenu, headerProps }
}

const DROP_ZONE: Record<Dock, string> = {
  left: 'inset-y-2 left-2 w-1/3',
  right: 'inset-y-2 right-2 w-1/3',
  top: 'inset-x-2 top-2 h-1/3',
  bottom: 'inset-x-2 bottom-2 h-1/3'
}

/** Where a dragged panel would land, drawn over the whole layout area. */
export function PanelDropOverlay({ drag }: { drag: PanelDrag | null }): ReactNode {
  if (!drag) return null
  return (
    // Above the panels, so an xterm under the pointer does not take the drag's events.
    <div className="absolute inset-0 z-30 cursor-grabbing">
      <div
        className={`absolute flex items-center justify-center rounded-lg border-2 border-accent/70 bg-accent/15 transition-all duration-100 ${DROP_ZONE[drag.dock]}`}
      >
        <span className="rounded-md bg-panel px-2 py-1 text-[11.5px] text-ink shadow-lg">
          Move {PANEL_LABELS[drag.panel]} to the {DOCK_LABELS[drag.dock]}
        </span>
      </div>
    </div>
  )
}

const MENU_WIDTH = 240
const MENU_HEIGHT = 190

/** The menu of edges for a panel, at the point it was asked for and kept inside the window. */
export function PanelMenu({
  request,
  dock,
  onMove,
  onReset,
  onClose
}: {
  request: PanelMenuRequest | null
  dock: (panel: PanelId) => Dock
  onMove: (panel: PanelId, dock: Dock) => void
  onReset: () => void
  onClose: () => void
}): ReactNode {
  if (!request) return null
  const { panel } = request
  const left = Math.max(4, Math.min(request.x, window.innerWidth - MENU_WIDTH))
  const top = Math.max(4, Math.min(request.y, window.innerHeight - MENU_HEIGHT))
  return (
    <div className="fixed z-40" style={{ left, top }}>
      <ActionsMenu
        className="left-0 top-0"
        onClose={onClose}
        groups={[
          DOCKS.map((edge) => ({
            label: `Move ${PANEL_LABELS[panel]} to the ${DOCK_LABELS[edge]}`,
            disabled: edge === dock(panel),
            run: () => onMove(panel, edge)
          })),
          [{ label: 'Reset panel layout', run: onReset }]
        ]}
      />
    </div>
  )
}
