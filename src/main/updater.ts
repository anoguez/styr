import { app, BrowserWindow, dialog, ipcMain } from 'electron'
// electron-updater defines `autoUpdater` with a getter, which Node's ESM loader cannot see as a
// named export of a CommonJS module, so it has to come off the default export.
import electronUpdater from 'electron-updater'
import { loadSettings } from '@core/config.js'
import type { UpdateState } from '@core/types.js'
import { listSessions } from './terminal/ptyManager.js'

const { autoUpdater } = electronUpdater

/** First check waits for the window, so startup is never slowed by the network. */
const LAUNCH_DELAY_MS = 5_000
/** The app lives in the menu bar for days; a launch-only check would go stale. */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let state: UpdateState = { kind: 'unsupported' }

function setState(next: UpdateState): void {
  state = next
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send('updates:state', state)
}

/** electron-updater errors carry a stack and HTTP dump; the first line is the useful part. */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n')[0] ?? text
}

/**
 * Releases are published only after the build attaches the update files, so this should not
 * happen — but a release published by hand, or one from before the updater existed (v0.2.0), has
 * no latest-mac.yml. That is not a failure the user can act on: the version they have is still the
 * newest one installable.
 */
function isMissingUpdateManifest(error: unknown): boolean {
  return /latest-mac\.yml/.test(describe(error)) && /404|Cannot find/i.test(String(error))
}

function check(): void {
  if (!app.isPackaged) return
  // Already fetched; checking again would restart a finished download.
  if (state.kind === 'downloading' || state.kind === 'ready') return
  autoUpdater.checkForUpdates().catch((error: unknown) => {
    setState(
      isMissingUpdateManifest(error)
        ? { kind: 'current', checkedAt: new Date().toISOString() }
        : { kind: 'error', message: describe(error) }
    )
  })
}

/**
 * Restarting kills every terminal, and with it any agent mid-turn, so ask first whenever one is
 * open. Their chats survive and can be resumed. Declining keeps the update for the next quit.
 */
async function install(): Promise<boolean> {
  if (state.kind !== 'ready') return false
  const open = listSessions().length
  if (open > 0) {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      type: 'question' as const,
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Restart to install Styr ${state.version}?`,
      detail: `${open} terminal${open === 1 ? ' is' : 's are'} open. Agents running in them will stop; their chats can be resumed after the restart. Choose Later to install when you next quit.`
    }
    const { response } = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
    if (response !== 0) return false
  }
  // isSilent = false, isForceRunAfter = true: relaunch straight into the new version.
  autoUpdater.quitAndInstall(false, true)
  return true
}

/**
 * Updates come from this repository's GitHub Releases (the `publish` block in
 * electron-builder.yml). A downloaded update installs on the next quit, never on its own, because
 * relaunching would kill the agents running in the app's terminals.
 */
export function initUpdater(): void {
  ipcMain.handle('updates:state', () => state)
  ipcMain.handle('updates:check', () => {
    check()
    return state
  })
  ipcMain.handle('updates:install', () => install())

  // A dev build has no update feed and must never replace itself.
  if (!app.isPackaged) return

  setState({ kind: 'idle' })
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  let pendingVersion = ''
  autoUpdater.on('checking-for-update', () => setState({ kind: 'checking' }))
  autoUpdater.on('update-not-available', () =>
    setState({ kind: 'current', checkedAt: new Date().toISOString() })
  )
  autoUpdater.on('update-available', (info) => {
    pendingVersion = info.version
    setState({ kind: 'downloading', version: info.version, percent: 0 })
  })
  autoUpdater.on('download-progress', (progress) =>
    setState({
      kind: 'downloading',
      version: pendingVersion,
      percent: Math.round(progress.percent)
    })
  )
  autoUpdater.on('update-downloaded', (info) => setState({ kind: 'ready', version: info.version }))
  autoUpdater.on('error', (error) => {
    if (state.kind === 'ready') return
    setState(
      isMissingUpdateManifest(error)
        ? { kind: 'current', checkedAt: new Date().toISOString() }
        : { kind: 'error', message: describe(error) }
    )
  })

  const automatic = (): boolean => loadSettings().updates.checkAutomatically
  setTimeout(() => automatic() && check(), LAUNCH_DELAY_MS)
  setInterval(() => automatic() && check(), RECHECK_INTERVAL_MS)
}
