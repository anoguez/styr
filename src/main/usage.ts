import { ipcMain as electronIpcMain } from 'electron'
import { codexTranscript } from '@core/providers/codex.js'
import { createUsage, watchFiles } from '@host/usage.js'
import { electronHost } from './electronHost.js'
import { remoteRouter, routedIpcMain } from './remote.js'
import { findTask } from './taskIndex.js'
import { sessionTask } from './terminal/ptyManager.js'

export { MAX_PROMPT_CHARS, sendApprovalAnswer, sendPrompt } from '@host/usage.js'

/**
 * The host's usage and agent conversations (`src/host/usage.ts`), bound to the app's paths, main's
 * index and the terminals. Main imports it through this path, which is the one the main-process
 * ordering tests mock.
 */
/** Routed like `ipc.ts`'s handlers: a remote terminal's usage comes from its server. */
const ipcMain = routedIpcMain(electronIpcMain)

const usage = createUsage({
  broadcast: (channel, payload) => remoteRouter.fromLocal(channel, payload),
  appPaths: electronHost.appPaths,
  // A lambda: `ptyManager.ts` imports this module back, so its binding is read at call time.
  sessionTask: (terminalId) => sessionTask(terminalId),
  findTask,
  codexTranscript,
  watch: watchFiles
})

export const { usageEnv, forgetContext, publishAgentConversation } = usage

/** The agent's own prompt channel in a terminal, for Request changes (`agentsService`'s `prompts`). */
export const agentPrompts = {
  promptInbox: (terminalId: string): boolean =>
    usage.conversation(terminalId)?.promptInbox === true,
  promptAgent: (terminalId: string, text: string): Promise<boolean> =>
    usage.prompt(terminalId, text)
}

/** Serves the last reading and pushes each new one. */
export function initUsage(): void {
  ipcMain.handle('usage:claude', () => usage.claudeUsage())
  ipcMain.handle('usage:codex', (_event, terminalId: string) => usage.codexUsage(terminalId))
  ipcMain.handle('usage:context', (_event, terminalId: string) => usage.context(terminalId))
  ipcMain.handle('agent:conversation', (_event, terminalId: string) =>
    usage.conversation(String(terminalId))
  )
  ipcMain.handle('agent:prompt', (_event, terminalId: string, text: unknown) =>
    usage.prompt(String(terminalId), text)
  )
  ipcMain.handle(
    'agent:approval',
    (_event, terminalId: string, approvalId: string, optionId: string) =>
      usage.approval(String(terminalId), String(approvalId), String(optionId))
  )
  usage.start()
}
