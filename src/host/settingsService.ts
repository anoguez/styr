import { workspaceDir } from '@core/config.js'
import { resolveShell } from '@core/platformShell.js'
import { providerFor } from '@core/providers/index.js'
import { loadSettings, persistSettings } from '@core/settingsStore.js'
import { settingsChangeSchema, workspaceIdSchema } from '@core/taskSchema.js'
import type { AgentProviderId } from '@core/providers/types.js'
import type { Settings, SettingsChange } from '@core/types.js'

/** The settings files, from `core/settingsStore.ts`. */
export interface SettingsStore {
  load(workspaceId?: string): Settings
  /** Writes a change from the Settings dialog to the global and workspace files. */
  persist(change: SettingsChange): void
}

export const diskSettingsStore: SettingsStore = {
  load: (workspaceId) => loadSettings(workspaceId),
  persist: persistSettings
}

export interface SettingsServicePorts {
  store: SettingsStore
  /** The workspaces service's follow-up to a save: repoint a moved folder, restart watchers. */
  afterSave(folderBefore: string, workspaceId: string): void
  /** Dispatch's follow-up: the Auto-run flag may have changed. */
  autoRunFlagChanged(): void
  /** Where the MCP server's entry point is on this install. */
  mcpEntry(): string
}

/** The `settings:*` reads and writes, and the MCP install command shown in Settings. */
export function createSettingsService(ports: SettingsServicePorts) {
  const { store } = ports

  function get(workspaceId: unknown): Settings {
    return store.load(workspaceIdSchema.optional().parse(workspaceId))
  }

  /** Saves a change; whatever the write did, the workspaces and Auto-run catch up with it. */
  function save(change: unknown): Settings {
    const parsed = settingsChangeSchema.parse(change)
    const folderBefore = workspaceDir(store.load())
    try {
      store.persist(parsed)
    } finally {
      ports.afterSave(folderBefore, parsed.workspaceId)
      ports.autoRunFlagChanged()
    }
    return store.load()
  }

  /** The command that registers Styr's MCP server with the provider's CLI, in the terminal's shell. */
  function mcpCommand(provider?: AgentProviderId): string {
    const entry = ports.mcpEntry()
    return providerFor({
      ...store.load(),
      defaultProvider: provider ?? 'claude'
    }).mcpInstallCommand(entry, resolveShell(store.load().shell).syntax)
  }

  return { get, save, mcpCommand }
}

export type SettingsService = ReturnType<typeof createSettingsService>
