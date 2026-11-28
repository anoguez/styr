import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PANEL_LAYOUT,
  MIN_CONTENT_SIZE,
  MIN_PANEL_SIZE,
  clampPanelSize,
  dockEdge,
  panelGrid,
  resolvePanelSizes,
  dropDockAt,
  movePanel,
  panelSizeFor,
  parsePanelLayout,
  resizePanel,
  resizedPanelSize
} from './panelLayout.js'

describe('panel layout', () => {
  it('defaults to the terminal at the bottom and the agents on the right', () => {
    expect(DEFAULT_PANEL_LAYOUT.terminal.dock).toBe('bottom')
    expect(DEFAULT_PANEL_LAYOUT.agents.dock).toBe('right')
  })

  it('keeps a size when a panel moves along the same axis, and drops it across axes', () => {
    const sized = resizePanel(DEFAULT_PANEL_LAYOUT, 'terminal', 300)
    expect(movePanel(sized, 'terminal', 'top').terminal).toEqual({ dock: 'top', size: 300 })
    expect(movePanel(sized, 'terminal', 'left').terminal).toEqual({ dock: 'left', size: null })
    expect(movePanel(sized, 'terminal', 'bottom')).toBe(sized)
    expect(movePanel(sized, 'terminal', 'left').agents).toBe(sized.agents)
  })

  it('opens the terminal at a share of the room until it is resized', () => {
    expect(panelSizeFor({ dock: 'bottom', size: null }, 'terminal', 1000)).toBe(450)
    expect(panelSizeFor({ dock: 'right', size: 320 }, 'terminal', 1000)).toBe(320)
    expect(panelSizeFor({ dock: 'right', size: null }, 'agents', 1000)).toBe(288)
  })

  it('never shrinks a panel below its floor or squeezes the content out', () => {
    expect(clampPanelSize('terminal', 10, 1000)).toBe(MIN_PANEL_SIZE.terminal)
    expect(clampPanelSize('terminal', 5000, 1000)).toBe(1000 - MIN_CONTENT_SIZE)
    // A window too small for both keeps the panel's floor.
    expect(clampPanelSize('agents', 400, 300)).toBe(MIN_PANEL_SIZE.agents)
  })

  it('grows a panel as its edge is dragged away from it', () => {
    expect(resizedPanelSize('terminal', 'bottom', 300, -50, 1000)).toBe(350)
    expect(resizedPanelSize('terminal', 'top', 300, -50, 1000)).toBe(250)
    expect(resizedPanelSize('agents', 'right', 300, 40, 1000)).toBe(260)
    expect(resizedPanelSize('agents', 'left', 300, 40, 1000)).toBe(340)
  })

  it('drops on the nearest edge, relative to the area', () => {
    expect(dropDockAt(10, 300, 1000, 600)).toBe('left')
    expect(dropDockAt(990, 300, 1000, 600)).toBe('right')
    expect(dropDockAt(500, 20, 1000, 600)).toBe('top')
    expect(dropDockAt(500, 590, 1000, 600)).toBe('bottom')
    // 200px in from the left of 1000 (20%) is nearer than 150px up from the bottom of 600 (25%).
    expect(dropDockAt(200, 450, 1000, 600)).toBe('left')
  })

  it('puts the border on the edge that faces the content', () => {
    expect(dockEdge('left').border).toBe('border-r')
    expect(dockEdge('right').border).toBe('border-l')
    expect(dockEdge('bottom').cursor).toBe('cursor-row-resize')
  })

  it('docks the panel moved last inside the other one', () => {
    const terminalLeft = movePanel(DEFAULT_PANEL_LAYOUT, 'terminal', 'left')
    expect(terminalLeft.outer).toBe('agents')
    const agentsBottom = movePanel(terminalLeft, 'agents', 'bottom')
    expect(agentsBottom.outer).toBe('terminal')
  })

  it('lays the default out as the board over the terminal, the agents at full height', () => {
    const open = { open: { terminal: true, agents: true }, terminalFills: false }
    const grid = panelGrid(DEFAULT_PANEL_LAYOUT, open, {
      terminal: { size: 300 },
      agents: { size: 288 }
    })
    expect(grid.areas).toBe(
      '"board agents-handle agents" "terminal-handle agents-handle agents" "terminal agents-handle agents"'
    )
    expect(grid.columns).toBe('minmax(0,1fr) 4px 288px')
    expect(grid.rows).toBe('minmax(0,1fr) 4px 300px')
  })

  it('keeps the terminal at full height when the agents move to the bottom after it', () => {
    const layout = movePanel(
      movePanel(DEFAULT_PANEL_LAYOUT, 'terminal', 'left'),
      'agents',
      'bottom'
    )
    const open = { open: { terminal: true, agents: true }, terminalFills: false }
    const grid = panelGrid(layout, open, { terminal: { size: 400 }, agents: { size: 220 } })
    expect(grid.areas).toBe(
      '"terminal terminal-handle board" "terminal terminal-handle agents-handle" "terminal terminal-handle agents"'
    )
    expect(grid.columns).toBe('400px 4px minmax(0,1fr)')
    expect(grid.rows).toBe('minmax(0,1fr) 4px 220px')
  })

  it('gives a closed panel no room, and an expanded terminal the board’s', () => {
    const closed = panelGrid(
      DEFAULT_PANEL_LAYOUT,
      { open: { terminal: false, agents: true }, terminalFills: false },
      { terminal: { size: 300 }, agents: { size: 288 } }
    )
    expect(closed.rows).toBe('minmax(0,1fr) 0px 0px')
    const filled = panelGrid(
      DEFAULT_PANEL_LAYOUT,
      { open: { terminal: true, agents: true }, terminalFills: true },
      { terminal: { size: 300 }, agents: { size: 288 } }
    )
    expect(filled.rows).toBe('0px 0px minmax(0,1fr)')
  })

  it('sizes the inner panel against the room the outer one leaves on its axis', () => {
    const layout = movePanel(DEFAULT_PANEL_LAYOUT, 'terminal', 'right')
    const sizes = resolvePanelSizes(
      layout,
      { open: { terminal: true, agents: true }, terminalFills: false },
      { width: 1200, height: 800 }
    )
    expect(sizes.agents).toEqual({ size: 288, room: 1200 })
    expect(sizes.terminal.room).toBe(1200 - 288 - 4)
  })

  it('reads a saved layout leniently', () => {
    expect(parsePanelLayout(null)).toEqual(DEFAULT_PANEL_LAYOUT)
    expect(
      parsePanelLayout({ terminal: { dock: 'left', size: 412.6 }, agents: { dock: 'nowhere' } })
    ).toEqual({
      terminal: { dock: 'left', size: 413 },
      agents: DEFAULT_PANEL_LAYOUT.agents,
      outer: 'agents'
    })
    expect(parsePanelLayout({ terminal: { dock: 'top', size: -3 } }).terminal).toEqual({
      dock: 'top',
      size: null
    })
  })
})
