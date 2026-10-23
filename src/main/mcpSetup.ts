import { loadSettings } from '@core/settingsStore.js'
import { execFileShell } from '@host/agentCli.js'
import { createMcpSetupChecks } from '@host/mcpSetup.js'
import { mcpEntry } from './mcpEntry.js'

/** The host's MCP setup checks (`src/host/mcpSetup.ts`), run through a real shell. */
export const { mcpSetupStatus } = createMcpSetupChecks(
  execFileShell,
  () => mcpEntry(),
  () => loadSettings()
)
