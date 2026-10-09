import type { ShortcutCommand, Task } from '@core/types.js'
import type { AgentRow } from './agentRows.js'
import type { SectionId } from '../components/settings/sections.js'
import type { PaletteMode } from './paletteMode.js'
import { isTerminalCommand, type TerminalCommand } from './terminalCommands.js'

export type View = 'board' | 'inbox'

/** The New task / edit dialog: a new task may start from a preset picked in the palette. */
export type TaskDialogState =
  { mode: 'closed' } | { mode: 'new'; presetId?: string } | { mode: 'edit'; task: Task }

/** The overlays that are simply open or closed. */
export type Toggle =
  | 'quickAdd'
  | 'archive'
  | 'performance'
  | 'switcher'
  | 'newWorkspace'
  | 'confirmDispatch'
  | 'confirmAutoStop'

/** What `App` shows around the board: the view, the sidebar and every dialog and overlay. */
export interface AppShellState extends Record<Toggle, boolean> {
  view: View
  agentsOpen: boolean
  palette: PaletteMode | null
  taskDialog: TaskDialogState
  /** Open Settings, at a section when one was asked for. */
  settings: { section?: SectionId } | null
  changes: Task | null
  removingAgent: AgentRow | null
}

export function initialAppShell(view: View): AppShellState {
  return {
    view,
    agentsOpen: true,
    palette: null,
    taskDialog: { mode: 'closed' },
    settings: null,
    changes: null,
    removingAgent: null,
    quickAdd: false,
    archive: false,
    performance: false,
    switcher: false,
    newWorkspace: false,
    confirmDispatch: false,
    confirmAutoStop: false
  }
}

export type AppShellAction =
  | { type: 'setView'; view: View }
  | { type: 'toggleAgents' }
  | { type: 'closeAgents' }
  /** The same palette key closes it; the other one switches mode. */
  | { type: 'togglePalette'; mode: PaletteMode }
  | { type: 'closePalette' }
  | { type: 'newTask'; presetId?: string }
  | { type: 'editTask'; task: Task }
  | { type: 'closeTask' }
  | { type: 'set'; toggle: Toggle; open: boolean }
  | { type: 'openSettings'; section?: SectionId }
  | { type: 'closeSettings' }
  | { type: 'showChanges'; task: Task | null }
  | { type: 'confirmRemoveAgent'; row: AgentRow | null }
  | { type: 'openArchived'; task: Task }
  /** Esc closes the dialogs that have no Esc handling of their own. */
  | { type: 'escape' }
  /** Nothing carries over from one workspace to the next, an open task included. */
  | { type: 'workspaceChanged' }

const CLOSED_TASK: TaskDialogState = { mode: 'closed' }

export function appShellReducer(state: AppShellState, action: AppShellAction): AppShellState {
  switch (action.type) {
    case 'setView':
      return { ...state, view: action.view }
    case 'toggleAgents':
      return { ...state, agentsOpen: !state.agentsOpen }
    case 'closeAgents':
      return { ...state, agentsOpen: false }
    case 'togglePalette':
      return { ...state, palette: state.palette === action.mode ? null : action.mode }
    case 'closePalette':
      return { ...state, palette: null }
    case 'newTask':
      return { ...state, taskDialog: { mode: 'new', presetId: action.presetId } }
    case 'editTask':
      return { ...state, taskDialog: { mode: 'edit', task: action.task } }
    case 'closeTask':
    case 'workspaceChanged':
      return { ...state, taskDialog: CLOSED_TASK }
    case 'set':
      return { ...state, [action.toggle]: action.open }
    case 'openSettings':
      return { ...state, settings: { section: action.section } }
    case 'closeSettings':
      return { ...state, settings: null }
    case 'showChanges':
      return { ...state, changes: action.task }
    case 'confirmRemoveAgent':
      return { ...state, removingAgent: action.row }
    case 'openArchived':
      return { ...state, archive: false, taskDialog: { mode: 'edit', task: action.task } }
    case 'escape':
      return {
        ...state,
        taskDialog: CLOSED_TASK,
        settings: null,
        confirmDispatch: false,
        palette: null,
        switcher: false,
        newWorkspace: false,
        archive: false,
        changes: null
      }
  }
}

/** What a shortcut command reaches outside the shell state. */
export interface CommandPort {
  dispatch: (action: AppShellAction) => void
  focusSearch: () => void
  toggleTerminal: () => void
  autoRunOn: boolean
  startAutoRun: () => void
  newShell: () => void
  /** Terminal tabs in strip order, and the focused one. */
  sessions: readonly { id: string }[]
  activeSession: string | null
  selectSession: (id: string) => void
  closeSession: (id: string) => void
  /** The active terminal owns what these act on; it answers the event. */
  terminal: (command: TerminalCommand) => void
}

/** Runs one shortcut command, from a key or the palette: the only place commands are handled. */
export function runShortcutCommand(command: ShortcutCommand, port: CommandPort): void {
  if (isTerminalCommand(command)) return port.terminal(command)
  const { dispatch } = port
  switch (command) {
    case 'newTask':
      return dispatch({ type: 'newTask' })
    case 'quickTask':
      return dispatch({ type: 'set', toggle: 'quickAdd', open: true })
    case 'quickOpen':
      return dispatch({ type: 'togglePalette', mode: 'go' })
    case 'commandPalette':
      return dispatch({ type: 'togglePalette', mode: 'command' })
    case 'focusSearch':
      return port.focusSearch()
    case 'viewBoard':
      return dispatch({ type: 'setView', view: 'board' })
    case 'viewInbox':
      return dispatch({ type: 'setView', view: 'inbox' })
    case 'settings':
      return dispatch({ type: 'openSettings' })
    case 'toggleTerminal':
      return port.toggleTerminal()
    case 'toggleAgents':
      return dispatch({ type: 'toggleAgents' })
    case 'orchestrate':
      return dispatch({ type: 'set', toggle: 'confirmDispatch', open: true })
    case 'toggleAutoDispatch':
      // Starting Auto-run is harmless; stopping it is confirmed, since it ends the workspace's run.
      return port.autoRunOn
        ? dispatch({ type: 'set', toggle: 'confirmAutoStop', open: true })
        : port.startAutoRun()
    case 'newShell':
      return port.newShell()
    case 'closeShell':
      return port.activeSession ? port.closeSession(port.activeSession) : undefined
    case 'switchWorkspace':
      return dispatch({ type: 'set', toggle: 'switcher', open: true })
    case 'newWorkspace':
      return dispatch({ type: 'set', toggle: 'newWorkspace', open: true })
    case 'terminalTab1':
    case 'terminalTab2':
    case 'terminalTab3':
    case 'terminalTab4':
    case 'terminalTab5':
    case 'terminalTab6':
    case 'terminalTab7':
    case 'terminalTab8':
    case 'terminalTab9': {
      // Tab N, as in a browser; with no such tab the key does nothing.
      const target = port.sessions[Number(command.slice('terminalTab'.length)) - 1]
      return target ? port.selectSession(target.id) : undefined
    }
    default: {
      // Adding a command to SHORTCUT_COMMANDS is a compile error until it is handled here.
      const unhandled: never = command
      return unhandled
    }
  }
}
