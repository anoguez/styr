/** The OS the app runs on, from the preload (the renderer has no `process`). */
export const PLATFORM = window.api.app.platform

export const IS_MAC = PLATFORM === 'darwin'

/** What the OS calls its file browser, for "Reveal in …" labels. */
export const FILE_MANAGER = IS_MAC ? 'Finder' : PLATFORM === 'win32' ? 'Explorer' : 'Files'
