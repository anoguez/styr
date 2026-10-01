import { useEffect } from 'react'
import {
  DEFAULT_TERMINAL_PALETTE,
  TASK_STATUSES,
  type AnsiColour,
  type TerminalPalette,
  type ThemeSettings
} from '@core/types.js'
import { backgroundGradient, legibleOn, onColor, surfaceRamp } from '../lib/palette.js'

export const UI_FONTS: { id: string; label: string; stack: string }[] = [
  { id: 'system', label: 'System', stack: "ui-sans-serif, -apple-system, 'SF Pro Text', system-ui, sans-serif" },
  { id: 'helvetica', label: 'Helvetica Neue', stack: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { id: 'avenir', label: 'Avenir Next', stack: "'Avenir Next', Avenir, system-ui, sans-serif" },
  { id: 'georgia', label: 'Georgia', stack: "Georgia, 'Times New Roman', serif" },
  { id: 'mono', label: 'Monospace', stack: "ui-monospace, SFMono-Regular, Menlo, monospace" }
]

export const TERMINAL_FONTS: { label: string; stack: string }[] = [
  { label: 'System mono', stack: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  { label: 'SF Mono', stack: "'SF Mono', ui-monospace, Menlo, monospace" },
  { label: 'Menlo', stack: 'Menlo, monospace' },
  { label: 'Monaco', stack: 'Monaco, monospace' },
  { label: 'JetBrains Mono', stack: "'JetBrains Mono', ui-monospace, Menlo, monospace" },
  { label: 'Courier New', stack: "'Courier New', Courier, monospace" }
]

export const TERMINAL_PALETTES: { label: string; palette: TerminalPalette }[] = [
  { label: 'Default', palette: DEFAULT_TERMINAL_PALETTE },
  {
    label: 'Vivid',
    palette: {
      black: '#12202b', red: '#ff5f56', green: '#39d353', yellow: '#ffd63a',
      blue: '#3b9dff', magenta: '#d66bff', cyan: '#2ee6d6', white: '#d8e0ea',
      brightBlack: '#51606f', brightRed: '#ff8178', brightGreen: '#6ced7c',
      brightYellow: '#ffe479', brightBlue: '#79bcff', brightMagenta: '#e498ff',
      brightCyan: '#74f2e6', brightWhite: '#f4f8fc'
    }
  },
  {
    label: 'Muted',
    palette: {
      black: '#1e2a33', red: '#c0797d', green: '#8fa97f', yellow: '#cfae76',
      blue: '#7d99bd', magenta: '#a98bb5', cyan: '#78a8a8', white: '#bcc5cf',
      brightBlack: '#56646f', brightRed: '#d59a9d', brightGreen: '#abc49c',
      brightYellow: '#e0c698', brightBlue: '#9db5d3', brightMagenta: '#c2a9cc',
      brightCyan: '#99c3c3', brightWhite: '#e4eaf0'
    }
  },
  {
    label: 'Mono',
    palette: {
      black: '#1a242c', red: '#8d9aa5', green: '#9aa7b2', yellow: '#a8b4be',
      blue: '#8792a0', magenta: '#95a1ad', cyan: '#a1adb8', white: '#c4ced8',
      brightBlack: '#5c6874', brightRed: '#b3bdc7', brightGreen: '#bdc7d0',
      brightYellow: '#c7d0d9', brightBlue: '#aab5c0', brightMagenta: '#b8c2cc',
      brightCyan: '#c2ccd5', brightWhite: '#eaeef3'
    }
  }
]

/** `brightBlack` as "Bright black" — the slot names are regular enough not to need a lookup. */
export function ansiLabel(slot: AnsiColour): string {
  const words = slot.replace(/([A-Z])/g, ' $1').toLowerCase().trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function uiFontStack(id: string): string {
  return (UI_FONTS.find((font) => font.id === id) ?? UI_FONTS[0]!).stack
}

/**
 * Writes the theme onto the document's CSS variables. Every colour in the app resolves through
 * these, so changing one repaints the board, cards, agent states and terminal dots together.
 */
export function useTheme(theme: ThemeSettings): void {
  useEffect(() => {
    const root = document.documentElement
    const ramp = surfaceRamp(theme.base)
    root.style.setProperty('--color-chrome', ramp.chrome)
    root.style.setProperty('--color-surface', ramp.surface)
    root.style.setProperty('--color-panel', ramp.panel)
    root.style.setProperty('--color-card', ramp.card)
    root.style.setProperty('--color-raised', ramp.raised)
    root.style.setProperty('--color-edge', ramp.edge)
    root.style.setProperty('--color-edge-strong', ramp.edgeStrong)
    root.style.setProperty('--color-ink', ramp.ink)
    root.style.setProperty('--color-dim', ramp.dim)
    root.style.setProperty('--color-faint', ramp.faint)
    root.style.setProperty('--color-accent', theme.accent)
    root.style.setProperty('--color-on-accent', onColor(theme.accent))
    root.style.setProperty('--color-accent-text', legibleOn(theme.accent, ramp.surface))
    for (const status of TASK_STATUSES) {
      const key = status === 'in_progress' ? 'progress' : status === 'in_review' ? 'review' : status
      const colour = theme.columns[status]
      root.style.setProperty(`--color-col-${key}`, colour)
      root.style.setProperty(`--color-col-${key}-text`, legibleOn(colour, ramp.surface))
    }
    root.style.setProperty(
      '--app-gradient',
      theme.gradient
        ? backgroundGradient(theme.base, theme.accent, theme.gradientStrength, theme.gradientAngle)
        : 'none'
    )
    root.style.setProperty('--font-ui', uiFontStack(theme.uiFont))
  }, [theme])
}
