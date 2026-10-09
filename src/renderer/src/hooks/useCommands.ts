import { useCallback, useEffect, useMemo } from 'react'
import { commandForEvent } from '@core/shortcuts.js'
import type { ShortcutCommand, TerminalSessionInfo } from '@core/types.js'
import type { CommandEntry } from '../components/CommandPalette.js'
import { runShortcutCommand, type AppShellAction } from '../lib/appShell.js'
import {
  buildCommandEntries,
  type PaletteActions,
  type PaletteSource
} from '../lib/commandEntries.js'
import { dispatchTerminalCommand } from '../lib/terminalCommands.js'
import { isTerminalTarget } from '../lib/terminalKeys.js'

/**
 * Every way to run a command: the keydown chain (Esc first; while Changes is open only Esc gets
 * through), the status bar, and the command palette's entries. Commands are handled by `runShortcutCommand`, the palette is built by
 * `buildCommandEntries`; this hook wires both to the live app.
 */
export function useCommands({
  dispatch,
  changesOpen,
  terminals,
  newShell,
  autoRun,
  palette,
  actions
}: {
  dispatch: (action: AppShellAction) => void
  /** The Changes viewer is modal: its own keys must not reach the board. */
  changesOpen: boolean
  terminals: {
    sessions: TerminalSessionInfo[]
    activeSession: string | null
    toggleTerminal: () => void
    select: (id: string) => void
    close: (id: string) => Promise<void>
  }
  newShell: () => Promise<void>
  autoRun: { on: boolean; setOn: (on: boolean) => void }
  /** What the palette lists, apart from the open tabs and Auto-run, which come from above. */
  palette: Omit<PaletteSource, 'sessions' | 'autoRunOn'>
  actions: Pick<PaletteActions, 'switchWorkspace' | 'archiveTask' | 'launchAgent' | 'activateTask'>
}): { runCommand: (command: ShortcutCommand) => void; entries: CommandEntry[] } {
  const { sessions, activeSession, toggleTerminal, select, close } = terminals
  const { on: autoRunOn, setOn: setAutoOn } = autoRun

  const runCommand = useCallback(
    (command: ShortcutCommand) =>
      runShortcutCommand(command, {
        dispatch,
        toggleTerminal,
        autoRunOn,
        startAutoRun: () => setAutoOn(true),
        newShell: () => void newShell(),
        sessions,
        activeSession,
        selectSession: select,
        closeSession: (id) => void close(id),
        terminal: dispatchTerminalCommand
      }),
    [
      dispatch,
      toggleTerminal,
      autoRunOn,
      setAutoOn,
      newShell,
      sessions,
      activeSession,
      select,
      close
    ]
  )

  const { bindings } = palette
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') return dispatch({ type: 'escape' })
      if (changesOpen) return
      const command = commandForEvent(bindings, event, {
        terminalFocused: isTerminalTarget(event.target as Element | null)
      })
      if (!command) return
      event.preventDefault()
      runCommand(command)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [bindings, changesOpen, dispatch, runCommand])

  const {
    tasks,
    agentRows,
    taskTitles,
    withChanges,
    archivedCount,
    presets,
    experimental,
    workspaces,
    activeWorkspaceId,
    workspaceNames,
    terminalOpen,
    agentsOpen
  } = palette
  const { switchWorkspace, archiveTask, launchAgent, activateTask } = actions
  const entries = useMemo(
    () =>
      buildCommandEntries(
        {
          tasks,
          agentRows,
          sessions,
          taskTitles,
          withChanges,
          archivedCount,
          presets,
          experimental,
          bindings,
          workspaces,
          activeWorkspaceId,
          workspaceNames,
          terminalOpen,
          agentsOpen,
          autoRunOn
        },
        {
          dispatch,
          runCommand,
          switchWorkspace,
          archiveTask,
          launchAgent,
          activateTask,
          selectSession: select
        }
      ),
    [
      tasks,
      agentRows,
      sessions,
      taskTitles,
      withChanges,
      archivedCount,
      presets,
      experimental,
      bindings,
      workspaces,
      activeWorkspaceId,
      workspaceNames,
      terminalOpen,
      agentsOpen,
      autoRunOn,
      dispatch,
      runCommand,
      switchWorkspace,
      archiveTask,
      launchAgent,
      activateTask,
      select
    ]
  )

  return { runCommand, entries }
}
