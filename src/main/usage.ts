import { codexTranscript } from '@core/providers/codex.js'
import { createUsage, watchFiles } from '@host/usage.js'
import { electronHost } from './electronHost.js'
import { remoteRouter } from './remote.js'
import { findTask } from './taskIndex.js'
import { sessionTask } from './terminal/ptyManager.js'

export { MAX_PROMPT_CHARS, sendApprovalAnswer, sendPrompt } from '@host/usage.js'

/**
 * The host's usage and agent conversations (`src/host/usage.ts`), bound to the app's paths, main's
 * index and the terminals. Main imports it through this path, which is the one the main-process
 * ordering tests mock.
 */
export const usage = createUsage({
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

/** Pushes each new reading; the channels that serve them are in the shared table (`ipc.ts`). */
export function initUsage(): void {
  usage.start()
}
