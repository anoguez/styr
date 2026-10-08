import { join } from 'node:path'
import { app } from 'electron'

/**
 * The app icon as a PNG, for Linux, where neither the window nor the tray gets one from the
 * executable. Shipped next to the asar (`linux.extraResources`) when packaged; read from the repo
 * in development.
 */
export function linuxIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'resources', 'icon.png')
}
