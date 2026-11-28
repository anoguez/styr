import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_PANEL_LAYOUT,
  movePanel,
  parsePanelLayout,
  resizePanel,
  type Dock,
  type PanelId,
  type PanelLayout
} from '../lib/panelLayout.js'

const KEY_PREFIX = 'styr:panelLayout:'

/** The saved layout of one workspace; a blocked or empty store gives the default. */
export function loadPanelLayout(workspaceId: string): PanelLayout {
  try {
    const saved = localStorage.getItem(KEY_PREFIX + workspaceId)
    return saved ? parsePanelLayout(JSON.parse(saved)) : DEFAULT_PANEL_LAYOUT
  } catch {
    return DEFAULT_PANEL_LAYOUT
  }
}

function savePanelLayout(workspaceId: string, layout: PanelLayout): void {
  try {
    localStorage.setItem(KEY_PREFIX + workspaceId, JSON.stringify(layout))
  } catch {
    // A convenience: a blocked store only means the layout resets on the next launch.
  }
}

/**
 * Where the terminal and agents panels sit, remembered per workspace across launches. It is kept
 * in the window's own storage rather than the workspace's `settings.json`: it is how this window
 * is arranged, and a remote workspace's server should not move the panels of every client.
 */
export function usePanelLayout(workspaceId: string): {
  layout: PanelLayout
  move: (panel: PanelId, dock: Dock) => void
  resize: (panel: PanelId, size: number | null) => void
  reset: () => void
} {
  const [state, setState] = useState(() => ({
    workspaceId,
    layout: loadPanelLayout(workspaceId)
  }))
  // Switching workspace shows that workspace's own layout, read during render so the first frame
  // after the switch is already right.
  if (state.workspaceId !== workspaceId) {
    setState({ workspaceId, layout: loadPanelLayout(workspaceId) })
  }

  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (!dirty) return
    savePanelLayout(state.workspaceId, state.layout)
    setDirty(false)
  }, [dirty, state])

  const update = useCallback((change: (layout: PanelLayout) => PanelLayout) => {
    setState((current) => {
      const layout = change(current.layout)
      return layout === current.layout ? current : { ...current, layout }
    })
    setDirty(true)
  }, [])

  const move = useCallback(
    (panel: PanelId, dock: Dock) => update((layout) => movePanel(layout, panel, dock)),
    [update]
  )
  const resize = useCallback(
    (panel: PanelId, size: number | null) => update((layout) => resizePanel(layout, panel, size)),
    [update]
  )
  const reset = useCallback(() => update(() => DEFAULT_PANEL_LAYOUT), [update])
  return { layout: state.layout, move, resize, reset }
}
