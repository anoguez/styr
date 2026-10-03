import {
  ensureWorkspaceSettingsFile,
  legacyWorkspaceSettings,
  loadSettings,
  stripLegacyWorkspaceKeys
} from './settingsStore.js'
import { DEFAULT_WORKSPACE_ID } from './types.js'
import { listWorkspaces } from './workspaces.js'

/**
 * Moves the workspace values a config from before workspace settings carries into every
 * workspace that has no settings file yet — before the split they all shared those values, so
 * each keeps exactly what it had. The config loses them only after every file is written, so an
 * interrupted run leaves them in place and the next start finishes it. Idempotent; run once at
 * startup by the main process, the only writer. The MCP server never runs it: until it completes,
 * `loadSettings` still layers the legacy values in.
 */
export function migrateLegacySettings(): void {
  const legacy = legacyWorkspaceSettings()
  if (!legacy) return
  const settings = loadSettings(DEFAULT_WORKSPACE_ID)
  for (const workspace of listWorkspaces(settings)) {
    ensureWorkspaceSettingsFile(settings, workspace.id, legacy)
  }
  stripLegacyWorkspaceKeys()
}
