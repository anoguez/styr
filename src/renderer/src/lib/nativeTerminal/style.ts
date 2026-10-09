import type { ITheme } from '@xterm/xterm'
import {
  ENGINE_COLOR_DEFAULT,
  ENGINE_COLOR_RGB,
  ENGINE_FLAGS,
  type EngineColor,
  type EngineRun
} from '@core/types.js'

/** The colours a run resolves against; built from the same xterm theme the standard engine uses. */
export interface RunPalette {
  foreground: string
  background: string
  cursor: string
  /** The 16 ANSI colours, black to bright white. */
  ansi: readonly string[]
}

const ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const

/** `terminalTheme`'s colours; it always sets the chrome and all 16 ANSI colours. */
export function paletteFromTheme(theme: ITheme): RunPalette {
  const colours = theme as Partial<Record<string, string>>
  const foreground = theme.foreground ?? 'currentColor'
  return {
    foreground,
    background: theme.background ?? 'transparent',
    cursor: theme.cursor ?? foreground,
    ansi: ANSI_KEYS.map((key) => colours[key] ?? foreground)
  }
}

const hex = (value: number): string => value.toString(16).padStart(2, '0')

/** Palette indices 16–255: the 6×6×6 colour cube, then a 24-step grey ramp. */
function extendedColour(index: number): string {
  if (index >= 232) {
    const level = 8 + (index - 232) * 10
    return `#${hex(level)}${hex(level)}${hex(level)}`
  }
  const cube = index - 16
  const level = (step: number): number => (step === 0 ? 0 : 55 + step * 40)
  return `#${hex(level(Math.floor(cube / 36)))}${hex(level(Math.floor(cube / 6) % 6))}${hex(level(cube % 6))}`
}

/** A protocol colour as CSS, or null for the default (the caller's foreground or background). */
export function colourOf(colour: EngineColor, palette: RunPalette): string | null {
  if (colour === ENGINE_COLOR_DEFAULT) return null
  if (colour >= ENGINE_COLOR_RGB)
    return `#${(colour - ENGINE_COLOR_RGB).toString(16).padStart(6, '0')}`
  if (colour < 16) return palette.ansi[colour] ?? null
  if (colour <= 255) return extendedColour(colour)
  return null
}

export interface RunStyle {
  color?: string
  backgroundColor?: string
  fontWeight?: 'bold'
  fontStyle?: 'italic'
  opacity?: number
  textDecorationLine?: string
  textDecorationStyle?: 'double' | 'wavy'
  visibility?: 'hidden'
}

/**
 * Inline style for one run. Inverse is resolved here, against the theme, so a default-coloured
 * inverse run (a selection in less, a status bar) shows the theme's colours swapped.
 */
export function runStyle(run: EngineRun, palette: RunPalette): RunStyle {
  const flags = run.flags
  let fg = colourOf(run.fg, palette)
  let bg = colourOf(run.bg, palette)
  if (flags & ENGINE_FLAGS.inverse) {
    ;[fg, bg] = [bg ?? palette.background, fg ?? palette.foreground]
  }
  const style: RunStyle = {}
  if (fg) style.color = fg
  if (bg) style.backgroundColor = bg
  if (flags & ENGINE_FLAGS.bold) style.fontWeight = 'bold'
  if (flags & ENGINE_FLAGS.italic) style.fontStyle = 'italic'
  if (flags & ENGINE_FLAGS.dim) style.opacity = 0.6
  const lines = [
    flags & (ENGINE_FLAGS.underline | ENGINE_FLAGS.doubleUnderline | ENGINE_FLAGS.undercurl)
      ? 'underline'
      : '',
    flags & ENGINE_FLAGS.strikethrough ? 'line-through' : ''
  ].filter(Boolean)
  if (lines.length > 0) style.textDecorationLine = lines.join(' ')
  if (flags & ENGINE_FLAGS.doubleUnderline) style.textDecorationStyle = 'double'
  if (flags & ENGINE_FLAGS.undercurl) style.textDecorationStyle = 'wavy'
  if (flags & ENGINE_FLAGS.hidden) style.visibility = 'hidden'
  return style
}
