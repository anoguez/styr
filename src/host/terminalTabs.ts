import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configDir } from '@core/config.js'
import {
  composeLayout,
  inTabOrder,
  layoutEntry,
  offerFor,
  parseLayoutFile,
  shellSkip,
  splitPending,
  type LayoutEntry
} from '@core/terminalLayout.js'
import type {
  RestoreTabsMode,
  TabsOffer,
  TabsRestoreResult,
  TerminalSessionInfo
} from '@core/types.js'

/** `~/.styr/terminal-tabs.json` (under `STYR_HOME` too): machine-local, so not a setting. */
export interface TabsStore {
  read(): string | undefined
  write(text: string): void
}

export const diskTabsStore: TabsStore = {
  read: () => {
    try {
      return readFileSync(join(configDir(), 'terminal-tabs.json'), 'utf8')
    } catch {
      return undefined
    }
  },
  write: (text) => {
    const path = join(configDir(), 'terminal-tabs.json')
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, path)
  }
}

export interface TerminalTabsPorts {
  store: TabsStore
  settings(): { restoreTabs: RestoreTabsMode; activeWorkspaceId: string }
  /** The ids of the workspaces that exist; an agent tab of a deleted one is dropped. */
  workspaceIds(): string[]
  terminals: {
    listSessions(): TerminalSessionInfo[]
    /** Where the shell is now (`TerminalRuntimeState.cwd`). */
    currentDirectory(id: string): string | undefined
    /** A shell tab in the current Settings shell. */
    createShell(options: { cwd: string; title: string }): TerminalSessionInfo
  }
  agents: { restoreAgent(taskId: string): Promise<TerminalSessionInfo> }
  directoryExists(path: string): boolean
  now(): string
}

/**
 * The terminal tabs across a relaunch: writes the layout on every tab change, offers it on the next
 * start and restores it. The main process owns the file; the renderer reports only the tab order and
 * the active tab. See `docs/architecture/ui.md`, Restoring tabs.
 */
export function createTerminalTabsService(ports: TerminalTabsPorts) {
  /** The last session's entries nobody has answered yet. They stay in the file before the live ones. */
  let pending: LayoutEntry[] = []
  let pendingActive: LayoutEntry | undefined
  let loaded = false
  let order: string[] = []
  let activeId: string | null = null
  let quitting = false
  let restoring = false
  let lastWritten = ''

  const mode = (): RestoreTabsMode => ports.settings().restoreTabs

  function load(): void {
    if (loaded) return
    loaded = true
    const text = ports.store.read()
    const file = text === undefined ? undefined : parseLayoutFile(text)
    if (!file) return
    pending = file.tabs
    pendingActive = file.active === undefined ? undefined : file.tabs[file.active]
  }

  /** Writes the file, unless nothing but the time changed. Quitting and `never` write nothing. */
  function save(): void {
    if (quitting || mode() === 'never') return
    load()
    const live: LayoutEntry[] = []
    let liveActive: number | undefined
    for (const session of inTabOrder(ports.terminals.listSessions(), order)) {
      const entry = layoutEntry(
        session,
        ports.terminals.currentDirectory(session.id) ?? session.cwd
      )
      if (!entry) continue
      if (session.id === activeId) liveActive = live.length
      live.push(entry)
    }
    const file = composeLayout(pending, pendingActive, live, liveActive, ports.now())
    const signature = JSON.stringify({ ...file, savedAt: '' })
    if (signature === lastWritten) return
    try {
      ports.store.write(`${JSON.stringify(file, null, 2)}\n`)
      lastWritten = signature
    } catch (error) {
      console.error('Could not save the terminal tabs:', error)
    }
  }

  /** The renderer's tab order and active tab. */
  function setLayout(ids: string[], active: string | null): void {
    if (quitting) return
    order = ids
    activeId = active
    save()
  }

  /** Called before the sessions are killed on quit, so their exits do not empty the file. */
  function freeze(): void {
    quitting = true
  }

  /** What the banner offers in the active workspace; null when nothing waits. */
  function offer(): TabsOffer | null {
    if (mode() === 'never') return null
    load()
    const known = new Set(ports.workspaceIds())
    const before = pending.length
    pending = pending.filter(
      (entry) => entry.kind === 'shell' || known.has(entry.workspaceId ?? '')
    )
    if (pending.length !== before) save()
    const { now } = splitPending(pending, ports.settings().activeWorkspaceId)
    return offerFor(now, mode() === 'always')
  }

  function answered(entries: readonly LayoutEntry[]): void {
    pending = pending.filter((entry) => !entries.includes(entry))
    if (pendingActive && entries.includes(pendingActive)) pendingActive = undefined
  }

  /** Dismiss: the shells' and this workspace's entries are forgotten for good. */
  function dismiss(): void {
    if (mode() === 'never') return
    load()
    answered(splitPending(pending, ports.settings().activeWorkspaceId).now)
    save()
  }

  /**
   * Reopens the entries that can be restored now, one at a time in saved order, after the tabs
   * already open. A tab that cannot come back is skipped and reported; the others still do.
   */
  async function restore(): Promise<TabsRestoreResult> {
    const result: TabsRestoreResult = { sessions: [], skipped: [] }
    if (mode() === 'never' || restoring) return result
    load()
    restoring = true
    try {
      const { now } = splitPending(pending, ports.settings().activeWorkspaceId)
      for (const entry of now) {
        // Out of the pending list first, so the tab it opens is saved once, as a live one.
        const wasActive = entry === pendingActive
        answered([entry])
        try {
          const session = await open(entry)
          if (!session) continue
          result.sessions.push(session)
          if (wasActive) result.activeId = session.id
        } catch (error) {
          result.skipped.push(error instanceof Error ? error.message : String(error))
        }
      }
    } finally {
      restoring = false
      save()
    }
    return result
  }

  async function open(entry: LayoutEntry): Promise<TerminalSessionInfo | undefined> {
    if (entry.kind === 'agent') {
      if (!entry.taskId) return undefined
      return ports.agents.restoreAgent(entry.taskId)
    }
    const reason = shellSkip(entry, ports.directoryExists(entry.cwd))
    if (reason) throw new Error(reason)
    return ports.terminals.createShell({ cwd: entry.cwd, title: entry.title })
  }

  return { setLayout, freeze, offer, dismiss, restore, changed: save }
}

export type TerminalTabsService = ReturnType<typeof createTerminalTabsService>
