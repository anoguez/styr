import { Menu, Notification, Tray, app, nativeImage } from 'electron'
import {
  AGENT_STATE_LABELS,
  compareAgentStatus,
  type AgentState,
  type AgentStatus
} from '@core/agentState.js'
import { TRAY_ICON_1X, TRAY_ICON_2X } from './trayIcon.js'

export interface TrayHandlers {
  onShowWindow: () => void
  onActivateTask: (taskId: string) => void
  onQuit: () => void
}

const STATE_MARK: Record<AgentState, string> = {
  waiting: '●',
  working: '◐',
  ready: '○',
  idle: '✓',
  exited: '·'
}

/** A menu bar list is for glancing at, not browsing — the rest live in the app's sidebar. */
const MENU_LIMIT = 8

let tray: Tray | null = null
let handlers: TrayHandlers | null = null
const lastState = new Map<string, AgentState>()

function icon(): Electron.NativeImage {
  const image = nativeImage.createFromDataURL(TRAY_ICON_1X)
  image.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_2X })
  image.setTemplateImage(true)
  return image
}

function labelFor(status: AgentStatus, titles: Map<string, string>): string {
  const title = titles.get(status.taskId) ?? status.taskId
  const trimmed = title.length > 46 ? `${title.slice(0, 45)}…` : title
  return `${STATE_MARK[status.state]}  ${trimmed} — ${AGENT_STATE_LABELS[status.state]}`
}

/**
 * Agents that have just entered the waiting state. Only transitions count, so a turn that stays
 * blocked for minutes notifies once rather than on every refresh.
 */
export function newlyWaiting(
  previous: ReadonlyMap<string, AgentState>,
  statuses: AgentStatus[]
): AgentStatus[] {
  return statuses.filter(
    (status) => status.state === 'waiting' && previous.get(status.taskId) !== 'waiting'
  )
}

function notifyNewlyWaiting(statuses: AgentStatus[], titles: Map<string, string>): void {
  const fresh = newlyWaiting(lastState, statuses)
  lastState.clear()
  for (const status of statuses) lastState.set(status.taskId, status.state)
  if (!Notification.isSupported()) return

  for (const status of fresh) {
    const notification = new Notification({
      title: 'Claude needs you',
      body: titles.get(status.taskId) ?? status.taskId,
      silent: false
    })
    notification.on('click', () => handlers?.onActivateTask(status.taskId))
    notification.show()
  }
}

export function createTray(next: TrayHandlers): void {
  handlers = next
  if (tray) return
  tray = new Tray(icon())
  tray.setToolTip('Styr')
}

export function updateTray(statuses: AgentStatus[], titles: Map<string, string>): void {
  notifyNewlyWaiting(statuses, titles)
  if (!tray) return

  const waiting = statuses.filter((status) => status.state === 'waiting')
  const active = statuses.filter((status) => status.state !== 'exited')

  tray.setTitle(waiting.length > 0 ? ` ${waiting.length}` : '')
  tray.setToolTip(
    waiting.length > 0
      ? `${waiting.length} agent${waiting.length === 1 ? '' : 's'} waiting on you`
      : 'Styr'
  )
  app.dock?.setBadge(waiting.length > 0 ? String(waiting.length) : '')

  const ranked = [...active].sort(compareAgentStatus)
  const shown = ranked.slice(0, MENU_LIMIT)
  const hidden = ranked.length - shown.length

  const agentItems: Electron.MenuItemConstructorOptions[] =
    shown.length > 0
      ? [
          ...shown.map((status) => ({
            label: labelFor(status, titles),
            click: () => handlers?.onActivateTask(status.taskId)
          })),
          ...(hidden > 0
            ? [
                {
                  label: `${hidden} more — open Styr`,
                  click: () => handlers?.onShowWindow()
                }
              ]
            : [])
        ]
      : [{ label: 'No agents running', enabled: false }]

  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...agentItems,
      { type: 'separator' },
      { label: 'Open Styr', click: () => handlers?.onShowWindow() },
      { type: 'separator' },
      { label: 'Quit Styr', click: () => handlers?.onQuit() }
    ])
  )
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
