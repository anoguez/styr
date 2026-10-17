import { createAgentCliChecks, execFileShell } from '@host/agentCli.js'

/**
 * The host's agent CLI checks (`src/host/agentCli.ts`), run through a real shell. `ipc.ts` imports
 * them through this path, which is the one the main-process ordering tests mock.
 */
export const { agentCliStatus, ensureAgentCli } = createAgentCliChecks(execFileShell)
