import { describe, expect, it } from 'vitest'
import type { AgentState, AgentStatus } from '@core/agentState.js'
import { DEFAULT_SHORTCUTS, type ShortcutBindings } from '@core/types.js'
import {
  MENU_LIMIT,
  trayMenu,
  windowInFront,
  type TrayItem,
  type TrayMenuInput,
  type TrayWindowState
} from './trayMenu.js'

function agent(taskId: string, state: AgentState): AgentStatus {
  return { taskId, state, at: '2026-10-22T10:00:00.000Z' }
}

function input(overrides: Partial<TrayMenuInput> = {}): TrayMenuInput {
  return {
    statuses: [],
    titles: new Map(),
    inFront: false,
    autoRun: null,
    bindings: DEFAULT_SHORTCUTS,
    ...overrides
  }
}

/** The menu as its labels, `---` for a separator, `(x)` around a row that cannot be clicked. */
function labels(items: TrayItem[]): string[] {
  return items.map((entry) => {
    if (entry.type === 'separator') return '---'
    return entry.enabled ? entry.label : `(${entry.label})`
  })
}

function find(items: TrayItem[], label: string): Extract<TrayItem, { type: 'item' }> {
  const found = items.find((entry) => entry.type === 'item' && entry.label === label)
  if (!found || found.type !== 'item') throw new Error(`no item ${label}`)
  return found
}

describe('windowInFront', () => {
  const front: TrayWindowState = { exists: true, visible: true, minimized: false, focused: true }

  it('on macOS needs the window focused, since the status menu leaves it key', () => {
    expect(windowInFront(front, 'darwin')).toBe(true)
    expect(windowInFront({ ...front, focused: false }, 'darwin')).toBe(false)
    expect(windowInFront({ ...front, minimized: true }, 'darwin')).toBe(false)
    expect(windowInFront({ ...front, visible: false }, 'darwin')).toBe(false)
    expect(windowInFront({ ...front, exists: false }, 'darwin')).toBe(false)
  })

  it('on Windows and Linux ignores focus, which clicking the tray always takes', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(windowInFront({ ...front, focused: false }, platform)).toBe(true)
      expect(windowInFront({ ...front, minimized: true }, platform)).toBe(false)
      expect(windowInFront({ ...front, visible: false }, platform)).toBe(false)
    }
  })
})

describe('trayMenu', () => {
  it('offers Open Styr only while the window is not in front', () => {
    expect(labels(trayMenu(input()))).toEqual([
      '(No agents running)',
      '---',
      'Quick add task…',
      'Open Inbox',
      '---',
      'Open Styr',
      '---',
      'Quit Styr'
    ])
    expect(labels(trayMenu(input({ inFront: true })))).toEqual([
      '(No agents running)',
      '---',
      'Quick add task…',
      'Open Inbox',
      '---',
      'Quit Styr'
    ])
  })

  it('lists at most MENU_LIMIT agents, waiting first, without exited ones', () => {
    const statuses = [
      agent('TASK-0001', 'working'),
      agent('TASK-0002', 'exited'),
      agent('TASK-0003', 'waiting')
    ]
    const titles = new Map([['TASK-0003', 'Needs me']])
    const rows = labels(trayMenu(input({ statuses, titles }))).slice(0, 2)
    expect(rows[0]).toBe('●  Needs me — Waiting on you')
    expect(rows[1]).toMatch(/^◐ {2}TASK-0001/)

    const many = Array.from({ length: MENU_LIMIT + 3 }, (_, i) => agent(`TASK-${i}`, 'working'))
    const away = trayMenu(input({ statuses: many }))
    expect(labels(away)).toContain('3 more — open Styr')
    expect(find(away, '3 more — open Styr').action).toEqual({ kind: 'show' })
    expect(labels(trayMenu(input({ statuses: many, inFront: true })))).toContain(
      '(3 more in the agents sidebar)'
    )
  })

  it('opens a row’s task in its own workspace', () => {
    const status = { ...agent('TASK-0001', 'waiting'), workspaceId: 'ws2', workspaceName: 'Two' }
    const [row] = trayMenu(input({ statuses: [status] }))
    expect(row).toMatchObject({
      label: '●  Two · TASK-0001 — Waiting on you',
      action: { kind: 'activate', taskId: 'TASK-0001', workspaceId: 'ws2' }
    })
  })

  it('shows the quick actions’ bound keys, and none once unbound', () => {
    const items = trayMenu(input())
    expect(find(items, 'Quick add task…')).toMatchObject({
      accelerator: 'CmdOrCtrl+Shift+N',
      action: { kind: 'command', command: 'quickTask' }
    })
    expect(find(items, 'Open Inbox')).toMatchObject({
      accelerator: 'Ctrl+2',
      action: { kind: 'command', command: 'viewInbox' }
    })
    const unbound: ShortcutBindings = { ...DEFAULT_SHORTCUTS, quickTask: [] }
    expect(find(trayMenu(input({ bindings: unbound })), 'Quick add task…').accelerator).toBe(
      undefined
    )
  })

  it('starts Auto-run directly and asks in the window before stopping it', () => {
    const off = trayMenu(input({ autoRun: { workspaceName: 'Styr', state: { on: false } } }))
    expect(labels(off)).toContain('(Auto-run in Styr: off)')
    expect(find(off, 'Start Auto-run').action).toEqual({ kind: 'startAutoRun' })

    const on = trayMenu(input({ autoRun: { workspaceName: 'Styr', state: { on: true } } }))
    expect(labels(on)).toContain('(Auto-run in Styr: on)')
    expect(find(on, 'Stop Auto-run…').action).toEqual({ kind: 'command', command: 'stopAutoRun' })
  })

  it('says why Auto-run switched itself off', () => {
    const limit = trayMenu(
      input({ autoRun: { workspaceName: 'Styr', state: { on: false, paused: 'limit' } } })
    )
    expect(labels(limit)).toContain('(Stopped itself: too many starts in an hour)')
    const failures = trayMenu(
      input({ autoRun: { workspaceName: 'Styr', state: { on: false, paused: 'failures' } } })
    )
    expect(labels(failures)).toContain('(Stopped itself: three launches in a row failed)')
  })

  it('leaves Auto-run out when its state cannot be read', () => {
    expect(labels(trayMenu(input())).some((label) => label.includes('Auto-run'))).toBe(false)
  })
})
