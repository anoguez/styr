import { createTerminalsService } from '@host/terminals/terminalsService.js'
import { nodePtySpawn } from '@host/terminals/nodePty.js'
import { usageEnv } from '../usage.js'

export type { SpawnOptions } from '@host/terminals/terminalsService.js'

/**
 * The host's terminals service (`src/host/terminals/`), bound to node-pty and the usage mod. Main
 * imports it through this path, which is the one the main-process ordering tests mock.
 */
const terminals = createTerminalsService({
  spawn: nodePtySpawn,
  // A lambda: `usage.ts` imports this module back, so its binding is read at call time.
  usageEnv: (existing, terminalId) => usageEnv(existing, terminalId)
})

export const {
  onTerminalData,
  onTerminalCreated,
  onTerminalExit,
  onTerminalRuntimeState,
  createSession,
  writeToSession,
  resizeSession,
  killSession,
  sessionBacklog,
  terminalRuntimeState,
  sessionTask,
  findSessionByTask,
  listSessions,
  killAllSessions
} = terminals
