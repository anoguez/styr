/**
 * What the app's window may load and open (`docs/architecture/remote.md`, Trust boundary). The
 * renderer shows text a remote host wrote, so a link in it, or a script that got in, must not be
 * able to take the window elsewhere or open anything but a web page on this machine:
 *
 * - the window never leaves the app's own page (`will-navigate`); a web link it tried to follow
 *   opens in the browser instead;
 * - a new window (`target="_blank"`, `window.open`) is never created, and only an `http(s)` URL is
 *   handed to the browser: `shell.openExternal` would run any other scheme (`file:`, `smb:`, an
 *   app's own) with this machine's handlers;
 * - no `<webview>` is ever attached.
 *
 * Electron-free beyond the shapes it is given, so it is tested without a window. `index.ts` binds
 * `guardNavigation` to every web contents and `openHandler` to the window.
 */

/** A web page: the only kind of link handed to the browser. */
export function isWebLink(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Whether `url` is the page already shown (a `#` change), not another document. */
export function isSameDocument(current: string, url: string): boolean {
  try {
    const a = new URL(current)
    const b = new URL(url)
    return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname
  } catch {
    return false
  }
}

/** A window-open handler: never a new window, and only a web link handed to the browser. */
export function openHandler(
  openExternal: (url: string) => void
): (details: { url: string }) => { action: 'deny' } {
  return ({ url }) => {
    if (isWebLink(url)) openExternal(url)
    return { action: 'deny' }
  }
}

/** The parts of `webContents` the navigation guard needs. */
export interface GuardedContents {
  getURL(): string
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault(): void }, url: string) => void
  ): void
  on(event: 'will-attach-webview', listener: (event: { preventDefault(): void }) => void): void
}

/** Keeps `contents` on its page and refuses webviews. Bound to every one (`web-contents-created`). */
export function guardNavigation(
  contents: GuardedContents,
  openExternal: (url: string) => void
): void {
  contents.on('will-navigate', (event, url) => {
    if (isSameDocument(contents.getURL(), url)) return
    event.preventDefault()
    if (isWebLink(url)) openExternal(url)
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}
