import { app, ipcMain } from 'electron'
import { pairLinkIn } from '@host/remote/lanLink.js'
import { broadcast } from './ipc.js'

/**
 * Clicking a `styr://pair?…` link (another computer's Add device, `styr serve pair`) opens Styr on
 * Add computer with the link filled in (`docs/architecture/remote-access.md`, Other computers).
 * The link only fills the dialog: pairing waits for the person to press Connect, so a link on a
 * web page cannot pair this computer by itself.
 *
 * Only a packaged app claims the scheme and the single-instance lock, so a dev build neither takes
 * the links from the installed app nor refuses to start beside it.
 */

/** The link clicked last, until the window takes it (`lan:takePairLink`). */
let pending: string | undefined

/**
 * Before `ready`: macOS delivers a link that launched the app as `open-url` before then. Returns
 * false when another Styr already runs, which then gets the link (`second-instance`) and this one
 * quits.
 */
export function initDeepLinks(showWindow: () => void): boolean {
  if (!app.isPackaged) return true
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }
  app.setAsDefaultProtocolClient('styr')

  const receive = (link: string | undefined): void => {
    if (!link) return
    pending = link
    // At start-up the window asks for it once it has loaded; later it is told one is waiting.
    if (!app.isReady()) return
    showWindow()
    broadcast('lan:pairLinkWaiting')
  }
  app.on('open-url', (event, url) => {
    event.preventDefault()
    receive(pairLinkIn([url]))
  })
  app.on('second-instance', (_event, argv) => {
    // Launched again with no link: bring the window forward, as a second launch would.
    if (app.isReady()) showWindow()
    receive(pairLinkIn(argv))
  })
  // Windows and Linux pass the link that launched the app in its arguments.
  receive(pairLinkIn(process.argv))
  return true
}

/** The window takes the waiting link, once. */
export function registerDeepLinkHandlers(): void {
  ipcMain.handle('lan:takePairLink', (): string | undefined => {
    const link = pending
    pending = undefined
    return link
  })
}
