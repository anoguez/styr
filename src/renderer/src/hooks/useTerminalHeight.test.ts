import { describe, expect, it } from 'vitest'
import { clampTerminalHeight } from './useTerminalHeight.js'

describe('clampTerminalHeight', () => {
  it('follows the pointer between the panel floor and the board floor', () => {
    expect(clampTerminalHeight(600, 1000)).toBe(400)
    // Dragged near the bottom: the panel keeps its minimum.
    expect(clampTerminalHeight(990, 1000)).toBe(140)
    // Dragged near the top: the board keeps its minimum.
    expect(clampTerminalHeight(10, 1000)).toBe(780)
  })

  it('keeps the panel minimum even in a window too short for both', () => {
    expect(clampTerminalHeight(0, 300)).toBe(140)
  })
})
