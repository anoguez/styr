import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME } from '../../../core/types.js'
import { contrastRatio, onColor, surfaceRamp } from './palette.js'
import { THEME_PRESETS, applyPreset } from './themePresets.js'

describe('theme presets', () => {
  it('keeps Harbour identical to the default theme', () => {
    const harbour = THEME_PRESETS[0]!
    expect(applyPreset(DEFAULT_THEME, harbour)).toEqual(DEFAULT_THEME)
  })

  it('applies a full palette, leaving fonts and gradient alone', () => {
    const preset = THEME_PRESETS.find((p) => p.label === 'Ember')!
    const next = applyPreset({ ...DEFAULT_THEME, gradient: false, terminalFontSize: 15 }, preset)
    expect(next.accent).toBe(preset.accent)
    expect(next.columns).toEqual(preset.columns)
    expect(next.gradient).toBe(false)
    expect(next.terminalFontSize).toBe(15)
  })

  it('keeps text readable on every surface', () => {
    for (const preset of THEME_PRESETS) {
      const ramp = surfaceRamp(preset.base)
      for (const surface of [ramp.chrome, ramp.surface, ramp.panel, ramp.card]) {
        expect(contrastRatio(ramp.ink, surface)).toBeGreaterThan(7)
        expect(contrastRatio(ramp.dim, surface)).toBeGreaterThan(4.5)
      }
      expect(onColor(preset.accent)).toBeTruthy()
    }
  })
})
