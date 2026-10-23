import { Menu, Notification, Tray, app, nativeImage } from 'electron'
import type { BrowserWindow } from 'electron'
import { linuxIconPath } from './appIcon.js'
import { agentKey, type AgentState, type AgentStatus } from '@core/agentState.js'
import type { ShortcutBindings, TrayCommand } from '@core/types.js'
import { TRAY_ICON_1X, TRAY_ICON_2X } from './trayIcon.js'
import {
  trayMenu,
  windowInFront,
  type TrayAction,
  type TrayAutoRun,
  type TrayItem,
  type TrayWindowState
} from './trayMenu.js'

export interface TrayHandlers {
  onShowWindow: () => void
  onActivateTask: (taskId: string, workspaceId?: string) => void
  /** Shows the window and has it run `command` (`app:command`). */
  onCommand: (command: TrayCommand) => void
  onStartAutoRun: () => void
  onQuit: () => void
  /** The shortcut bindings, read at each rebuild, for the items' accelerators. */
  shortcuts: () => ShortcutBindings
}

let tray: Tray | null = null
let handlers: TrayHandlers | null = null
const lastState = new Map<string, AgentState>()

/**
 * Everything the menu is built from. Each input is replaced by its own event (agents, the window,
 * Auto-run) and the whole menu is rebuilt from the latest of all of them — no timer.
 */
let agents: { statuses: AgentStatus[]; titles: Map<string, string> } = {
  statuses: [],
  titles: new Map()
}
let windowState: TrayWindowState = {
  exists: false,
  visible: false,
  minimized: false,
  focused: false
}
let autoRun: TrayAutoRun | null = null

function icon(): Electron.NativeImage {
  const image = nativeImage.createFromDataURL(TRAY_ICON_1X)
  image.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_2X })
  image.setTemplateImage(true)
  return image
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
    (status) => status.state === 'waiting' && previous.get(agentKey(status)) !== 'waiting'
  )
}

function notifyNewlyWaiting(
  statuses: AgentStatus[],
  titles: Map<string, string>,
  quiet: ReadonlySet<string>
): void {
  const fresh = newlyWaiting(lastState, statuses).filter((status) => !quiet.has(agentKey(status)))
  lastState.clear()
  for (const status of statuses) lastState.set(agentKey(status), status.state)
  if (!Notification.isSupported()) return

  for (const status of fresh) {
    const notification = new Notification({
      title: 'Claude needs you',
      body: `${status.workspaceName ? `${status.workspaceName} · ` : ''}${titles.get(agentKey(status)) ?? status.taskId}`,
      silent: false
    })
    notification.on('click', () => handlers?.onActivateTask(status.taskId, status.workspaceId))
    notification.show()
  }
}

export function createTray(next: TrayHandlers): void {
  handlers = next
  if (tray) return
  tray = new Tray(icon())
  tray.setToolTip('Styr')
  if (process.platform === 'win32') {
    // The macOS glyph is a black template image, close to invisible on a dark taskbar; the app's
    // own icon is what Windows users expect there. A left click opens the window, as on Windows.
    void app
      .getFileIcon(process.execPath, { size: 'small' })
      .then((image) => tray?.setImage(image))
      .catch(() => undefined)
    tray.on('click', () => handlers?.onShowWindow())
  } else if (process.platform === 'linux') {
    // Same reason as Windows: a black template glyph disappears on a dark panel. Linux trays show
    // the menu on click themselves, so no click handler.
    tray.setImage(nativeImage.createFromPath(linuxIconPath()).resize({ width: 22, height: 22 }))
  }
  rebuildTrayMenu()
}

/**
 * `quiet` holds agents that must not notify: a remote workspace's agents right after a
 * (re)connect, whose waiting began while disconnected — notifications come from the live stream
 * only, never as a backfill.
 */
export function updateTray(
  statuses: AgentStatus[],
  titles: Map<string, string>,
  quiet: ReadonlySet<string> = new Set()
): void {
  notifyNewlyWaiting(statuses, titles, quiet)
  agents = { statuses, titles }
  if (!tray) return

  const waiting = statuses.filter((status) => status.state === 'waiting')
  tray.setTitle(waiting.length > 0 ? ` ${waiting.length}` : '')
  tray.setToolTip(
    waiting.length > 0
      ? `${waiting.length} agent${waiting.length === 1 ? '' : 's'} waiting on you`
      : 'Styr'
  )
  app.dock?.setBadge(waiting.length > 0 ? String(waiting.length) : '')
  rebuildTrayMenu()
}

/** Auto-run of the active workspace, or null to leave the section out. */
export function setTrayAutoRun(next: TrayAutoRun | null): void {
  autoRun = next
  rebuildTrayMenu()
}

/**
 * Follows a window's visibility, so "Open Styr" shows only while it is not in front. `closed`
 * counts too: on macOS the app outlives its window.
 */
export function watchWindow(window: BrowserWindow): void {
  const read = (): void => {
    const gone = window.isDestroyed()
    windowState = {
      exists: !gone,
      visible: !gone && window.isVisible(),
      minimized: !gone && window.isMinimized(),
      focused: !gone && window.isFocused()
    }
    rebuildTrayMenu()
  }
  window.on('show', read)
  window.on('hide', read)
  window.on('focus', read)
  window.on('blur', read)
  window.on('minimize', read)
  window.on('restore', read)
  window.on('closed', () => {
    windowState = { exists: false, visible: false, minimized: false, focused: false }
    rebuildTrayMenu()
  })
  read()
}

function run(action: TrayAction): void {
  if (!handlers) return
  switch (action.kind) {
    case 'activate':
      return handlers.onActivateTask(action.taskId, action.workspaceId)
    case 'show':
      return handlers.onShowWindow()
    case 'command':
      return handlers.onCommand(action.command)
    case 'startAutoRun':
      return handlers.onStartAutoRun()
    case 'quit':
      return handlers.onQuit()
  }
}

function template(items: TrayItem[]): Electron.MenuItemConstructorOptions[] {
  return items.map((entry) => {
    if (entry.type === 'separator') return { type: 'separator' }
    const { label, enabled, accelerator, action } = entry
    return {
      label,
      enabled,
      // Shown only: the renderer's shortcut system handles the key itself.
      ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
      ...(action ? { click: () => run(action) } : {})
    }
  })
}

/** Rebuilds the menu from the latest inputs; cheap, so every input change calls it. */
function rebuildTrayMenu(): void {
  if (!tray || !handlers) return
  const items = trayMenu({
    ...agents,
    inFront: windowInFront(windowState, process.platform),
    autoRun,
    bindings: handlers.shortcuts()
  })
  tray.setContextMenu(Menu.buildFromTemplate(template(items)))
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
