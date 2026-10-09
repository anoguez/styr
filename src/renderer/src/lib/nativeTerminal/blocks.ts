import type { EngineFrame, TrackedBlock } from '@core/types.js'
import type { BlockLayout } from '../blockTracker.js'

type Viewport = Pick<EngineFrame, 'rows' | 'historySize' | 'displayOffset' | 'altScreen'>

/**
 * The buffer line at the top of the viewport. The engine numbers lines as xterm.js does (0 is the
 * oldest line in the scrollback), so it is the history above the screen less how far the viewport
 * is scrolled up into it.
 */
export function viewportTop(viewport: Viewport): number {
  return viewport.historySize - viewport.displayOffset
}

/** The command blocks laid out for `TerminalBlocks`, exactly as `BlockTracker` reports xterm's. */
export function nativeBlockLayout(
  viewport: Viewport,
  blocks: TrackedBlock[],
  cellHeight: number
): BlockLayout {
  return {
    blocks,
    viewportY: viewportTop(viewport),
    rows: viewport.rows,
    cellHeight,
    top: 0,
    alternate: viewport.altScreen
  }
}

/** The buffer line `offsetY` pixels below the terminal's top, or null outside its rows. */
export function lineAtOffset(
  viewport: Viewport,
  offsetY: number,
  cellHeight: number
): number | null {
  if (cellHeight <= 0) return null
  const row = Math.floor(offsetY / cellHeight)
  return row >= 0 && row < viewport.rows ? viewportTop(viewport) + row : null
}

/**
 * A session's blocks as the renderer last heard them. They arrive with the attach reply and then
 * with frame events, and an event may overtake the reply; one from the same engine is newer than
 * the reply, so it wins, while one from an engine since replaced is dropped.
 */
export class BlockFeed {
  private attachId: number | null = null
  private early: { attachId: number; blocks: TrackedBlock[] } | null = null
  blocks: TrackedBlock[] = []

  attached(attachId: number, blocks: TrackedBlock[]): void {
    this.attachId = attachId
    this.blocks = this.early?.attachId === attachId ? this.early.blocks : blocks
    this.early = null
  }

  /** Returns whether the blocks now shown changed. */
  received(attachId: number, blocks: TrackedBlock[]): boolean {
    if (this.attachId === null) {
      this.early = { attachId, blocks }
      return false
    }
    if (attachId !== this.attachId) return false
    this.blocks = blocks
    return true
  }
}
