import {
  DEFAULT_TERMINAL_PALETTE,
  DEFAULT_THEME,
  type TerminalPalette,
  type ThemeSettings
} from '../../../core/types.js'

/** The slice of a theme a built-in sets; fonts, gradient and the like stay the user's. */
export type ThemePalette = Pick<ThemeSettings, 'base' | 'accent' | 'columns' | 'terminalPalette'>

export interface ThemePreset extends ThemePalette {
  label: string
}

const LIGHT_TERMINAL_PALETTE: TerminalPalette = {
  black: '#2b3440',
  red: '#c0392b',
  green: '#2f8f4e',
  yellow: '#a8741a',
  blue: '#2f64c8',
  magenta: '#8e44ad',
  cyan: '#1b8a94',
  white: '#8a94a0',
  brightBlack: '#5c6773',
  brightRed: '#d9503f',
  brightGreen: '#3aa862',
  brightYellow: '#c08a26',
  brightBlue: '#4a7de0',
  brightMagenta: '#a459c4',
  brightCyan: '#2aa3ae',
  brightWhite: '#aab3bd'
}

/**
 * Built-in themes. Each carries a complete palette — base, accent and the four column colours are
 * chosen together from one hue family — so picking one never leaves an accent from another theme
 * behind. Harbour is the shipped default and is taken from DEFAULT_THEME, never restated.
 * Everything stays editable afterwards.
 */
export const THEME_PRESETS: ThemePreset[] = [
  {
    label: 'Harbour',
    base: DEFAULT_THEME.base,
    accent: DEFAULT_THEME.accent,
    columns: DEFAULT_THEME.columns,
    terminalPalette: DEFAULT_THEME.terminalPalette
  },
  {
    label: 'Midnight',
    base: '#0e1117',
    accent: '#5b6ee1',
    columns: { backlog: '#cdd5e6', in_progress: '#6f8dff', in_review: '#b49cff', done: '#4fd1c5' },
    terminalPalette: DEFAULT_TERMINAL_PALETTE
  },
  {
    label: 'Graphite',
    base: '#101010',
    accent: '#7a808a',
    columns: { backlog: '#e2e2e2', in_progress: '#7d9ac7', in_review: '#d6c27a', done: '#7fbf9a' },
    terminalPalette: DEFAULT_TERMINAL_PALETTE
  },
  {
    label: 'Deep sea',
    base: '#0b1418',
    accent: '#1f8a8a',
    columns: { backlog: '#d3ece9', in_progress: '#3fa7d6', in_review: '#e7d68a', done: '#2ec4a6' },
    terminalPalette: DEFAULT_TERMINAL_PALETTE
  },
  {
    label: 'Plum',
    base: '#141018',
    accent: '#8a4fa0',
    columns: { backlog: '#e8dcef', in_progress: '#9b8cf0', in_review: '#f0a8d0', done: '#6fd3b0' },
    terminalPalette: DEFAULT_TERMINAL_PALETTE
  },
  {
    label: 'Ember',
    base: '#1d0f0f',
    accent: '#c2562f',
    columns: { backlog: '#f0dcd0', in_progress: '#e8895a', in_review: '#f2c25b', done: '#8fc27a' },
    terminalPalette: DEFAULT_TERMINAL_PALETTE
  },
  {
    label: 'Moss',
    base: '#0d1410',
    accent: '#4f8a5b',
    columns: { backlog: '#dde8d6', in_progress: '#6fb58a', in_review: '#d3d27a', done: '#3fbf8f' },
    terminalPalette: DEFAULT_TERMINAL_PALETTE
  },
  {
    label: 'Daylight',
    base: '#eef2f7',
    accent: '#3b6fd8',
    columns: { backlog: '#5b6675', in_progress: '#2f6fe0', in_review: '#b7791f', done: '#0f8f6f' },
    terminalPalette: LIGHT_TERMINAL_PALETTE
  },
  {
    label: 'Paper',
    base: '#f5f0e6',
    accent: '#b4532a',
    columns: { backlog: '#6b6357', in_progress: '#3f7cac', in_review: '#b7791f', done: '#4f8a5b' },
    terminalPalette: LIGHT_TERMINAL_PALETTE
  }
]

export function applyPreset(theme: ThemeSettings, preset: ThemePreset): ThemeSettings {
  return {
    ...theme,
    base: preset.base,
    accent: preset.accent,
    columns: { ...preset.columns },
    terminalPalette: { ...preset.terminalPalette }
  }
}
