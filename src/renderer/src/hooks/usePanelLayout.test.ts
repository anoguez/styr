import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PANEL_LAYOUT } from '../lib/panelLayout.js'
import { loadPanelLayout } from './usePanelLayout.js'

function stubStorage(entries: Record<string, string>): void {
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries[key] ?? null })
}

describe('loadPanelLayout', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads each workspace under its own key', () => {
    stubStorage({
      'styr:panelLayout:a': JSON.stringify({ terminal: { dock: 'right', size: 500 } })
    })
    expect(loadPanelLayout('a').terminal).toEqual({ dock: 'right', size: 500 })
    expect(loadPanelLayout('b')).toEqual(DEFAULT_PANEL_LAYOUT)
  })

  it('falls back to the default on a corrupt entry or a blocked store', () => {
    stubStorage({ 'styr:panelLayout:a': '{not json' })
    expect(loadPanelLayout('a')).toEqual(DEFAULT_PANEL_LAYOUT)
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      }
    })
    expect(loadPanelLayout('a')).toEqual(DEFAULT_PANEL_LAYOUT)
  })
})
