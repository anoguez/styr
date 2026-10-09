import { describe, expect, it, vi } from 'vitest'
import { SHORTCUT_COMMANDS, type ShortcutCommand, type Task } from '@core/types.js'
import {
  appShellReducer as reduce,
  initialAppShell,
  runShortcutCommand,
  type AppShellAction,
  type CommandPort
} from './appShell.js'

const task = { id: 'TASK-0001', title: 'One' } as Task
const initial = initialAppShell('board')

function port(overrides: Partial<CommandPort> = {}): CommandPort & { actions: AppShellAction[] } {
  const actions: AppShellAction[] = []
  return {
    actions,
    dispatch: (action) => actions.push(action),
    focusSearch: vi.fn(),
    toggleTerminal: vi.fn(),
    autoRunOn: false,
    startAutoRun: vi.fn(),
    newShell: vi.fn(),
    sessions: [{ id: 's1' }, { id: 's2' }],
    activeSession: null,
    selectSession: vi.fn(),
    closeSession: vi.fn(),
    terminal: vi.fn(),
    ...overrides
  }
}

/** Runs a command against a fake port and folds what it dispatched into the shell state. */
function after(command: ShortcutCommand, overrides: Partial<CommandPort> = {}) {
  const fake = port(overrides)
  runShortcutCommand(command, fake)
  return fake.actions.reduce(reduce, initial)
}

describe('appShellReducer', () => {
  it('toggles the palette per mode: the same key closes it, the other switches', () => {
    const go = reduce(initial, { type: 'togglePalette', mode: 'go' })
    expect(go.palette).toBe('go')
    expect(reduce(go, { type: 'togglePalette', mode: 'command' }).palette).toBe('command')
    expect(reduce(go, { type: 'togglePalette', mode: 'go' }).palette).toBeNull()
  })

  it('opens a new task with or without a preset, and an existing one for editing', () => {
    expect(reduce(initial, { type: 'newTask', presetId: 'bug' }).taskDialog).toEqual({
      mode: 'new',
      presetId: 'bug'
    })
    expect(reduce(initial, { type: 'editTask', task }).taskDialog).toEqual({ mode: 'edit', task })
  })

  it('opening an archived task closes the archive', () => {
    const open = reduce(initial, { type: 'set', toggle: 'archive', open: true })
    const next = reduce(open, { type: 'openArchived', task })
    expect(next.archive).toBe(false)
    expect(next.taskDialog).toEqual({ mode: 'edit', task })
  })

  it('Esc closes the dialogs without their own Esc handling and leaves the rest', () => {
    let state = initial
    for (const action of [
      { type: 'editTask', task },
      { type: 'openSettings', section: 'theme' },
      { type: 'togglePalette', mode: 'go' },
      { type: 'showChanges', task },
      { type: 'set', toggle: 'confirmDispatch', open: true },
      { type: 'set', toggle: 'switcher', open: true },
      { type: 'set', toggle: 'newWorkspace', open: true },
      { type: 'set', toggle: 'archive', open: true },
      { type: 'set', toggle: 'quickAdd', open: true },
      { type: 'set', toggle: 'confirmAutoStop', open: true },
      { type: 'setView', view: 'inbox' }
    ] as AppShellAction[])
      state = reduce(state, action)

    const next = reduce(state, { type: 'escape' })
    expect(next).toMatchObject({
      taskDialog: { mode: 'closed' },
      settings: null,
      palette: null,
      changes: null,
      confirmDispatch: false,
      switcher: false,
      newWorkspace: false,
      archive: false,
      // These dialogs close themselves on Esc; the view is not a dialog.
      quickAdd: true,
      confirmAutoStop: true,
      view: 'inbox'
    })
  })

  it('a workspace change closes the task dialog only', () => {
    const state = reduce(reduce(initial, { type: 'editTask', task }), { type: 'openSettings' })
    const next = reduce(state, { type: 'workspaceChanged' })
    expect(next.taskDialog).toEqual({ mode: 'closed' })
    expect(next.settings).toEqual({ section: undefined })
  })
})

describe('runShortcutCommand', () => {
  it('handles every shortcut command', () => {
    for (const command of SHORTCUT_COMMANDS) {
      const sessions = Array.from({ length: 9 }, (_, index) => ({ id: `s${index + 1}` }))
      const fake = port({ activeSession: 's1', sessions })
      runShortcutCommand(command, fake)
      const touched =
        fake.actions.length > 0 ||
        [
          fake.focusSearch,
          fake.toggleTerminal,
          fake.startAutoRun,
          fake.newShell,
          fake.selectSession,
          fake.closeSession,
          fake.terminal
        ].some((fn) => vi.mocked(fn).mock.calls.length > 0)
      expect(touched, command).toBe(true)
    }
  })

  it('opens dialogs and switches views through the reducer', () => {
    expect(after('newTask').taskDialog).toEqual({ mode: 'new', presetId: undefined })
    expect(after('quickTask').quickAdd).toBe(true)
    expect(after('commandPalette').palette).toBe('command')
    expect(after('viewInbox').view).toBe('inbox')
    expect(after('settings').settings).toEqual({ section: undefined })
    expect(after('toggleAgents').agentsOpen).toBe(false)
    expect(after('orchestrate').confirmDispatch).toBe(true)
    expect(after('switchWorkspace').switcher).toBe(true)
  })

  it('starts Auto-run straight away but confirms before stopping it', () => {
    const off = port()
    runShortcutCommand('toggleAutoDispatch', off)
    expect(off.startAutoRun).toHaveBeenCalled()
    expect(after('toggleAutoDispatch', { autoRunOn: true }).confirmAutoStop).toBe(true)
  })

  it('selects tab N when it exists and ignores the key otherwise', () => {
    const fake = port()
    runShortcutCommand('terminalTab2', fake)
    expect(fake.selectSession).toHaveBeenCalledWith('s2')
    runShortcutCommand('terminalTab3', fake)
    expect(fake.selectSession).toHaveBeenCalledTimes(1)
  })

  it('closes the active shell only when there is one', () => {
    const none = port()
    runShortcutCommand('closeShell', none)
    expect(none.closeSession).not.toHaveBeenCalled()
    const one = port({ activeSession: 's2' })
    runShortcutCommand('closeShell', one)
    expect(one.closeSession).toHaveBeenCalledWith('s2')
  })

  it('hands terminal commands to the active terminal', () => {
    const fake = port()
    runShortcutCommand('terminalCopyOutput', fake)
    expect(fake.terminal).toHaveBeenCalledWith('terminalCopyOutput')
    expect(fake.actions).toEqual([])
  })
})
