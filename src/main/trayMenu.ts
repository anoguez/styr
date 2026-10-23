import {
  AGENT_STATE_LABELS,
  agentKey,
  compareAgentStatus,
  type AgentState,
  type AgentStatus
} from '@core/agentState.js'
import { menuAccelerator } from '@core/shortcuts.js'
import {
  AUTO_DISPATCH_PAUSE_LABELS,
  type AutoDispatchState,
  type ShortcutBindings,
  type TrayCommand
} from '@core/types.js'

/**
 * The tray menu as plain data: what `tray.ts` turns into an Electron menu. Pure (no `electron`), so
 * every combination of window, agents and Auto-run is tested without a tray.
 */

/** What clicking an item does; `tray.ts` maps each kind to a handler. */
export type TrayAction =
  | { kind: 'activate'; taskId: string; workspaceId?: string }
  | { kind: 'show' }
  | { kind: 'command'; command: TrayCommand }
  | { kind: 'startAutoRun' }
  | { kind: 'quit' }

export type TrayItem =
  | { type: 'separator' }
  | { type: 'item'; label: string; enabled: boolean; accelerator?: string; action?: TrayAction }

export interface TrayWindowState {
  exists: boolean
  visible: boolean
  minimized: boolean
  focused: boolean
}

/** Auto-run of the active workspace; null when its state cannot be read (a host is down). */
export interface TrayAutoRun {
  workspaceName: string
  state: AutoDispatchState
}

export interface TrayMenuInput {
  statuses: AgentStatus[]
  titles: Map<string, string>
  inFront: boolean
  autoRun: TrayAutoRun | null
  bindings: ShortcutBindings
}

/** A menu bar list is for glancing at, not browsing — the rest live in the app's sidebar. */
export const MENU_LIMIT = 8

const STATE_MARK: Record<AgentState, string> = {
  waiting: '●',
  working: '◐',
  ready: '○',
  idle: '✓',
  exited: '·'
}

/**
 * Whether the window is the one in front, so "Open Styr" has nothing to do. On macOS opening the
 * status item's menu leaves the window key, so focus is still true when the menu opens. On Windows
 * and Linux clicking the notification area takes focus from the window first, so focus would always
 * read false there; being on screen is the best the menu can know.
 */
export function windowInFront(window: TrayWindowState, platform: NodeJS.Platform): boolean {
  const onScreen = window.exists && window.visible && !window.minimized
  return platform === 'darwin' ? onScreen && window.focused : onScreen
}

function agentLabel(status: AgentStatus, titles: Map<string, string>): string {
  const title = titles.get(agentKey(status)) ?? status.taskId
  const trimmed = title.length > 46 ? `${title.slice(0, 45)}…` : title
  const where = status.workspaceName ? `${status.workspaceName} · ` : ''
  return `${STATE_MARK[status.state]}  ${where}${trimmed} — ${AGENT_STATE_LABELS[status.state]}`
}

function item(
  label: string,
  action?: TrayAction,
  accelerator?: string
): Extract<TrayItem, { type: 'item' }> {
  return { type: 'item', label, enabled: action !== undefined, accelerator, action }
}

const SEPARATOR: TrayItem = { type: 'separator' }

function agentItems({ statuses, titles, inFront }: TrayMenuInput): TrayItem[] {
  const ranked = statuses.filter((status) => status.state !== 'exited').sort(compareAgentStatus)
  if (ranked.length === 0) return [item('No agents running')]
  const shown = ranked.slice(0, MENU_LIMIT)
  const hidden = ranked.length - shown.length
  const rows: TrayItem[] = shown.map((status) =>
    item(agentLabel(status, titles), {
      kind: 'activate',
      taskId: status.taskId,
      workspaceId: status.workspaceId
    })
  )
  if (hidden > 0) {
    rows.push(
      inFront
        ? item(`${hidden} more in the agents sidebar`)
        : item(`${hidden} more — open Styr`, { kind: 'show' })
    )
  }
  return rows
}

function autoRunItems(autoRun: TrayAutoRun, bindings: ShortcutBindings): TrayItem[] {
  const { workspaceName, state } = autoRun
  const accelerator = menuAccelerator(bindings, 'toggleAutoDispatch')
  return [
    item(`Auto-run in ${workspaceName}: ${state.on ? 'on' : 'off'}`),
    ...(!state.on && state.paused ? [item(AUTO_DISPATCH_PAUSE_LABELS[state.paused])] : []),
    state.on
      ? item('Stop Auto-run…', { kind: 'command', command: 'stopAutoRun' }, accelerator)
      : item('Start Auto-run', { kind: 'startAutoRun' }, accelerator)
  ]
}

export function trayMenu(input: TrayMenuInput): TrayItem[] {
  const { bindings, autoRun, inFront } = input
  return [
    ...agentItems(input),
    SEPARATOR,
    item(
      'Quick add task…',
      { kind: 'command', command: 'quickTask' },
      menuAccelerator(bindings, 'quickTask')
    ),
    item(
      'Open Inbox',
      { kind: 'command', command: 'viewInbox' },
      menuAccelerator(bindings, 'viewInbox')
    ),
    ...(autoRun ? [SEPARATOR, ...autoRunItems(autoRun, bindings)] : []),
    SEPARATOR,
    ...(inFront ? [] : [item('Open Styr', { kind: 'show' }), SEPARATOR]),
    item('Quit Styr', { kind: 'quit' })
  ]
}
