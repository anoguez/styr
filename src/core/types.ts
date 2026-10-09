/**
 * Every domain type, re-exported from one place so callers import from `core/types` whatever the
 * domain. The types themselves live in `types/<domain>.ts` and `sources/types.ts`; only the theme,
 * which the Settings dialog and the renderer's defaults both need, is declared here.
 */
import type { TaskStatus } from './types/task.js'

export * from './types/task.js'
export * from './types/agents.js'
export * from './types/workspaces.js'
export * from './types/settings.js'
export * from './types/terminal.js'
export type {
  CliStatus,
  RemoteItem,
  SourceAccess,
  SourceConfig,
  SourceSyncState,
  SourceTarget
} from './sources/types.js'

export const ANSI_COLOURS = [
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

export type AnsiColour = (typeof ANSI_COLOURS)[number]

/**
 * The 16 colours a program picks from when it emits colour. Unlike the interface, these cannot be
 * derived from the base — red has to stay red — so they are stored outright.
 */
export type TerminalPalette = Record<AnsiColour, string>

export interface ThemeSettings {
  base: string
  gradient: boolean
  gradientStrength: number
  gradientAngle: number
  accent: string
  columns: Record<TaskStatus, string>
  uiFont: string
  terminalFont: string
  terminalFontSize: number
  terminalPalette: TerminalPalette
}

export const DEFAULT_TERMINAL_PALETTE: TerminalPalette = {
  black: '#1b2b38',
  red: '#e06c75',
  green: '#8cc98f',
  yellow: '#e5c07b',
  blue: '#6ea8fe',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#c8d1dc',
  brightBlack: '#4a5b6a',
  brightRed: '#f08b93',
  brightGreen: '#a7dba9',
  brightYellow: '#f2d49b',
  brightBlue: '#8fbdff',
  brightMagenta: '#d99af0',
  brightCyan: '#79cfd9',
  brightWhite: '#eef2f7'
}

export const DEFAULT_THEME: ThemeSettings = {
  base: '#0d2233',
  gradient: true,
  gradientStrength: 1,
  gradientAngle: 216,
  accent: '#6c3f75',
  columns: {
    backlog: '#f1f1e6',
    in_progress: '#5f8df7',
    in_review: '#f9f871',
    done: '#00c6c0'
  },
  uiFont: 'system',
  terminalFont: "'JetBrains Mono', ui-monospace, Menlo, monospace",
  terminalFontSize: 12,
  terminalPalette: DEFAULT_TERMINAL_PALETTE
}
