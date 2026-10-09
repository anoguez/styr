import { AGENT_STATE_LABELS } from '@core/agentState.js'
import { SHORTCUT_LABELS, shortcutHint } from '@core/shortcuts.js'
import {
  SHORTCUT_COMMANDS,
  type ExperimentalSettings,
  type ShortcutBindings,
  type ShortcutCommand,
  type Task,
  type TaskPreset,
  type TerminalSessionInfo,
  type WorkspaceOverview
} from '@core/types.js'
import type { AgentRow } from './agentRows.js'
import type { CommandEntry } from '../components/CommandPalette.js'
import { SECTIONS } from '../components/settings/sections.js'
import type { AppShellAction } from './appShell.js'
import { sessionLabel } from './sessionLabel.js'

/** What the palette lists: the board, the open tabs and the state its labels reflect. */
export interface PaletteSource {
  tasks: Task[]
  agentRows: AgentRow[]
  sessions: TerminalSessionInfo[]
  taskTitles: ReadonlyMap<string, string>
  /** Tasks with changes to show. */
  withChanges: { has: (taskId: string) => boolean }
  archivedCount: number
  presets: TaskPreset[]
  /** Absent until settings load; sections behind a flag stay hidden until then. */
  experimental?: ExperimentalSettings
  bindings: ShortcutBindings
  workspaces: WorkspaceOverview['workspaces']
  activeWorkspaceId: string
  workspaceNames: ReadonlyMap<string, string>
  terminalOpen: boolean
  agentsOpen: boolean
  autoRunOn: boolean
}

/** What the entries do when picked. */
export interface PaletteActions {
  dispatch: (action: AppShellAction) => void
  runCommand: (command: ShortcutCommand) => void
  switchWorkspace: (id: string) => void
  archiveTask: (taskId: string) => void
  launchAgent: (taskId: string) => void
  activateTask: (taskId: string) => void
  selectSession: (id: string) => void
}

const KEYWORDS: Partial<Record<ShortcutCommand, string>> = {
  orchestrate: 'orchestrate run agents',
  toggleAutoDispatch: 'orchestrate dispatch auto-run stop pause keep running',
  newShell: 'terminal session',
  closeShell: 'terminal session kill',
  settings: 'preferences options',
  quickTask: 'new capture backlog idea'
}

/** Every entry of the command palette, in display order within each group. */
export function buildCommandEntries(
  source: PaletteSource,
  actions: PaletteActions
): CommandEntry[] {
  const { dispatch } = actions
  const dynamicLabels: Partial<Record<ShortcutCommand, string>> = {
    toggleTerminal: source.terminalOpen ? 'Hide terminal' : 'Show terminal',
    toggleAgents: source.agentsOpen ? 'Hide agents sidebar' : 'Show agents sidebar',
    orchestrate: 'Dispatch — start waiting work',
    toggleAutoDispatch: source.autoRunOn ? 'Stop Dispatch auto-run' : 'Start Dispatch auto-run'
  }
  const entries: CommandEntry[] = SHORTCUT_COMMANDS.map((command) => ({
    id: `cmd:${command}`,
    label: dynamicLabels[command] ?? SHORTCUT_LABELS[command],
    group: 'Actions',
    mode: 'command',
    hint: shortcutHint(source.bindings, command),
    keywords: KEYWORDS[command],
    run: () => actions.runCommand(command)
  }))

  for (const preset of source.presets) {
    entries.push({
      id: `preset:${preset.id}`,
      mode: 'command',
      label: `New task from preset: ${preset.name}`,
      group: 'Actions',
      keywords: 'new task template preset',
      run: () => dispatch({ type: 'newTask', presetId: preset.id })
    })
  }

  for (const workspace of source.workspaces) {
    if (workspace.id === source.activeWorkspaceId) continue
    entries.push({
      id: `workspace:${workspace.id}`,
      label: `Switch to ${workspace.name}`,
      group: 'Workspaces',
      mode: 'command',
      hint: `${workspace.taskCount} task${workspace.taskCount === 1 ? '' : 's'}`,
      keywords: 'workspace board switch',
      run: () => actions.switchWorkspace(workspace.id)
    })
  }
  entries.push({
    id: 'view:performance',
    label: 'Show performance',
    group: 'Actions',
    mode: 'command',
    keywords: 'slow cpu memory profile diagnostics usage lag',
    run: () => dispatch({ type: 'set', toggle: 'performance', open: true })
  })
  entries.push({
    id: 'view:archive',
    label: `View archive (${source.archivedCount})`,
    group: 'Actions',
    mode: 'command',
    keywords: 'archived unarchive restore',
    run: () => dispatch({ type: 'set', toggle: 'archive', open: true })
  })

  for (const task of source.tasks) {
    if (task.status === 'done') {
      entries.push({
        id: `archive:${task.id}`,
        label: `Archive — ${task.title}`,
        group: 'Tasks',
        mode: 'command',
        hint: task.id,
        keywords: 'archive hide done',
        run: () => actions.archiveTask(task.id)
      })
    }
    if (source.withChanges.has(task.id)) {
      entries.push({
        id: `changes:${task.id}`,
        label: `View changes — ${task.title}`,
        group: 'Tasks',
        mode: 'command',
        hint: task.id,
        keywords: 'diff changes git files review',
        run: () => dispatch({ type: 'showChanges', task })
      })
    }
    entries.push({
      id: `task:${task.id}`,
      label: task.title,
      group: 'Tasks',
      mode: 'go',
      hint: task.id,
      keywords: `${task.status} ${task.project ?? ''} ${task.tags.join(' ')}`,
      run: () => dispatch({ type: 'editTask', task }),
      altLabel: 'start Claude',
      runAlt: () => actions.launchAgent(task.id)
    })
  }

  for (const row of source.agentRows) {
    const state = row.agent ? AGENT_STATE_LABELS[row.agent.state] : 'No status'
    entries.push({
      id: `agent:${row.task.id}`,
      label: `${state} — ${row.task.title}`,
      group: 'Agents',
      mode: 'go',
      hint: row.task.id,
      keywords: 'agent claude session',
      run: () => actions.activateTask(row.task.id)
    })
  }

  for (const session of source.sessions) {
    const { name, detail } = sessionLabel(session, source.taskTitles, {
      activeId: source.activeWorkspaceId,
      names: source.workspaceNames
    })
    entries.push({
      id: `term:${session.id}`,
      label: name,
      hint: detail || undefined,
      group: 'Terminals',
      mode: 'go',
      keywords: 'terminal tab session',
      run: () => actions.selectSession(session.id)
    })
  }

  for (const section of SECTIONS) {
    if ('flag' in section && !source.experimental?.[section.flag]) continue
    entries.push({
      id: `settings:${section.id}`,
      label: `Settings — ${section.label}`,
      group: 'Settings',
      mode: 'command',
      keywords: section.blurb,
      run: () => dispatch({ type: 'openSettings', section: section.id })
    })
  }

  return entries
}
