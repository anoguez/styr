/**
 * What the host's services need from the app that runs them. Electron implements these in
 * `src/main/electronHost.ts`; a headless `styr serve` will implement them without a window. Every
 * port is synchronous unless the operation it wraps already is not, so wiring a service through
 * one adds no async boundary.
 */
export interface HostPorts {
  /** Sends an event to every connected renderer. */
  broadcast(channel: string, payload?: unknown): void
  /** Raises a desktop notification, where the platform supports one. */
  notify(title: string, body: string): void
  /** Moves a file or folder to the trash. */
  trashItem(path: string): Promise<void>
  readonly appPaths: AppPaths
}

/** Where the running app lives. Read lazily: some values are only known once the app is ready. */
export interface AppPaths {
  readonly isPackaged: boolean
  readonly version: string
  /** The app's own folder (inside the asar archive when packaged). */
  readonly appPath: string
  /** The packaged app's resources folder. */
  readonly resourcesPath: string
}

/** A file or folder picker's options, in the subset Styr uses. */
export interface OpenDialogRequest {
  properties: ('openFile' | 'openDirectory' | 'createDirectory' | 'multiSelections')[]
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

/**
 * Operations bound to the window that asked for them. `Caller` is whatever identifies that window
 * to the implementation (Electron's `WebContents`); the services treat it as opaque.
 */
export interface WindowPorts<Caller> {
  /** Recolours the native window controls drawn over the title bar (Windows and Linux). */
  setTitleBarOverlay(caller: Caller, colors: { color: string; symbolColor: string }): void
  /** Opens a picker parented to the caller's window; resolves to the chosen paths, or null. */
  showOpenDialog(caller: Caller, options: OpenDialogRequest): Promise<string[] | null>
}
