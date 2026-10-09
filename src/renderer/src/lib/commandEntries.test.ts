import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_COMMANDS,
  type Task,
  type TerminalSessionInfo
} from '@core/types.js'
import type { AgentRow } from './agentRows.js'
import type { CommandEntry } from '../components/CommandPalette.js'
import { buildCommandEntries, type PaletteActions, type PaletteSource } from './commandEntries.js'

const task = (id: string, status: Task['status'] = 'backlog'): Task =>
  ({ id, title: `Title ${id}`, status, tags: ['ui'], project: 'styr' }) as Task

function source(overrides: Partial<PaletteSource> = {}): PaletteSource {
  return {
    tasks: [],
    agentRows: [],
    sessions: [],
    taskTitles: new Map(),
    withChanges: new Set<string>(),
    archivedCount: 0,
    presets: [],
    experimental: { externalSources: false, nativeTerminal: false },
    bindings: DEFAULT_SHORTCUTS,
    workspaces: [],
    activeWorkspaceId: 'default',
    workspaceNames: new Map([['default', 'Default']]),
    terminalOpen: false,
    agentsOpen: true,
    autoRunOn: false,
    ...overrides
  }
}

function actions(): PaletteActions {
  return {
    dispatch: vi.fn(),
    runCommand: vi.fn(),
    switchWorkspace: vi.fn(),
    archiveTask: vi.fn(),
    launchAgent: vi.fn(),
    activateTask: vi.fn(),
    selectSession: vi.fn()
  }
}

const byId = (entries: CommandEntry[], id: string): CommandEntry | undefined =>
  entries.find((entry) => entry.id === id)

describe('buildCommandEntries', () => {
  it('lists every shortcut command, labelled by the state it toggles', () => {
    const entries = buildCommandEntries(source({ terminalOpen: true, autoRunOn: true }), actions())
    for (const command of SHORTCUT_COMMANDS) expect(byId(entries, `cmd:${command}`)).toBeDefined()
    expect(byId(entries, 'cmd:toggleTerminal')?.label).toBe('Hide terminal')
    expect(byId(entries, 'cmd:toggleAgents')?.label).toBe('Hide agents sidebar')
    expect(byId(entries, 'cmd:toggleAutoDispatch')?.label).toBe('Stop Dispatch auto-run')
  })

  it('runs a command entry through the command handler', () => {
    const act = actions()
    byId(buildCommandEntries(source(), act), 'cmd:newShell')!.run()
    expect(act.runCommand).toHaveBeenCalledWith('newShell')
  })

  it('opens a new task from each preset', () => {
    const act = actions()
    const entries = buildCommandEntries(
      source({ presets: [{ id: 'bug', name: 'Bug' } as PaletteSource['presets'][number]] }),
      act
    )
    const entry = byId(entries, 'preset:bug')!
    expect(entry.label).toBe('New task from preset: Bug')
    entry.run()
    expect(act.dispatch).toHaveBeenCalledWith({ type: 'newTask', presetId: 'bug' })
  })

  it('offers every workspace but the open one', () => {
    const workspaces = [
      { id: 'default', name: 'Default', taskCount: 3, liveSessions: 0 },
      { id: 'other', name: 'Other', taskCount: 1, liveSessions: 0 }
    ] as PaletteSource['workspaces']
    const entries = buildCommandEntries(source({ workspaces }), actions())
    expect(byId(entries, 'workspace:default')).toBeUndefined()
    expect(byId(entries, 'workspace:other')).toMatchObject({
      label: 'Switch to Other',
      hint: '1 task'
    })
  })

  it('adds Archive for done tasks and View changes only where there are changes', () => {
    const act = actions()
    const entries = buildCommandEntries(
      source({ tasks: [task('A', 'done'), task('B')], withChanges: new Set(['B']) }),
      act
    )
    expect(byId(entries, 'archive:A')).toBeDefined()
    expect(byId(entries, 'archive:B')).toBeUndefined()
    expect(byId(entries, 'changes:A')).toBeUndefined()
    byId(entries, 'changes:B')!.run()
    expect(act.dispatch).toHaveBeenCalledWith({ type: 'showChanges', task: task('B') })
  })

  it('opens a task on Enter and launches its agent on the alternate action', () => {
    const act = actions()
    const entry = byId(buildCommandEntries(source({ tasks: [task('A')] }), act), 'task:A')!
    expect(entry).toMatchObject({ mode: 'go', keywords: 'backlog styr ui' })
    entry.run()
    expect(act.dispatch).toHaveBeenCalledWith({ type: 'editTask', task: task('A') })
    entry.runAlt!()
    expect(act.launchAgent).toHaveBeenCalledWith('A')
  })

  it('labels agents by state and terminals by their task title', () => {
    const rows = [
      { task: task('A'), agent: { state: 'waiting' } },
      { task: task('B') }
    ] as AgentRow[]
    const sessions = [
      { id: 's1', taskId: 'A', workspaceId: 'default', title: 'A' }
    ] as TerminalSessionInfo[]
    const entries = buildCommandEntries(
      source({ agentRows: rows, sessions, taskTitles: new Map([['A', 'Renamed']]) }),
      actions()
    )
    expect(byId(entries, 'agent:A')?.label).toMatch(/— Title A$/)
    expect(byId(entries, 'agent:B')?.label).toBe('No status — Title B')
    expect(byId(entries, 'term:s1')?.label).toBe('Renamed')
  })

  it('hides settings sections behind an experimental flag that is off', () => {
    const off = buildCommandEntries(source(), actions())
    expect(byId(off, 'settings:source-github')).toBeUndefined()
    expect(byId(off, 'settings:theme')).toBeDefined()
    const on = buildCommandEntries(
      source({ experimental: { externalSources: true, nativeTerminal: false } }),
      actions()
    )
    expect(byId(on, 'settings:source-github')).toBeDefined()
    expect(
      byId(
        buildCommandEntries(source({ experimental: undefined }), actions()),
        'settings:source-github'
      )
    ).toBeUndefined()
  })
})
