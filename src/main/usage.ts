import { basename, delimiter, join } from 'node:path'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync
} from 'node:fs'
import { app, BrowserWindow, ipcMain } from 'electron'
import chokidar from 'chokidar'
import { configDir } from '@core/config.js'
import { parseAgentConversation, type AgentConversation } from '@core/agentConversation.js'
import { codexTranscript } from '@core/providers/codex.js'
import { findTask } from './taskIndex.js'
import { sessionTask } from './terminal/ptyManager.js'
import {
  parseCodexRollout,
  parseContextFile,
  parseUsageFile,
  type ContextUsage,
  type ProviderUsage
} from '@core/usage.js'

/** Account-wide, so it lives beside the global config, not in a workspace. */
const claudeUsageFile = (): string => join(configDir(), 'usage', 'claude.json')

/** Plain files beside the asar when packaged (`extraResources`): Claude Code cannot read an asar. */
function claudeModsRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'claude')
    : join(app.getAppPath(), 'resources', 'claude')
}

/**
 * Environment that makes a Claude Code started in a Styr terminal load the usage mod and say where
 * to write. Added to every terminal, not just agent sessions: a shell tab can run `claude` too.
 * Any plugin folders the user already exports are kept, after this one.
 */
export function usageEnv(existing: string | undefined, terminalId: string): Record<string, string> {
  const mod = join(claudeModsRoot(), 'usage-mod')
  if (!existsSync(mod)) return {}
  return {
    // First: of two plugins with one name the earlier loads, and an inherited list can hold another
    // Styr's copy of this mod (an older install, or the app a dev build was started from).
    CLAUDE_CODE_PLUGIN_DIRS: existing ? `${mod}${delimiter}${existing}` : mod,
    STYR_USAGE_FILE: claudeUsageFile(),
    STYR_CONTEXT_FILE: contextFile(terminalId),
    STYR_CONVERSATION_FILE: conversationFile(terminalId),
    STYR_PROMPT_INBOX: promptInbox(terminalId)
  }
}

/** One file per terminal: context fill belongs to a session, unlike the account's quota. */
const contextDir = (): string => join(configDir(), 'usage', 'context')
const contextFile = (terminalId: string): string => join(contextDir(), `${terminalId}.json`)

/**
 * One file per terminal: the conversation of the agent CLI running in it, in Styr's neutral shape
 * (`agentConversation.ts`), which Styr Terminal draws as blocks. Claude Code's mod writes it.
 */
const conversationDir = (): string => join(configDir(), 'usage', 'conversation')
const conversationFile = (terminalId: string): string =>
  join(conversationDir(), `${terminalId}.json`)

/**
 * One file per terminal the other way: prompts typed in Styr's input, one JSON line each, which
 * the agent's side reads and submits as the person's own words (`promptInbox` in the conversation
 * says it is listening). Appended only; removed with the terminal.
 */
const inboxDir = (): string => join(configDir(), 'usage', 'inbox')
const promptInbox = (terminalId: string): string => join(inboxDir(), `${terminalId}.jsonl`)

/** Longest prompt sent through the inbox. */
export const MAX_PROMPT_CHARS = 100_000

/** Appends a prompt for the agent in `terminalId`; false when it is not one to send. */
export function sendPrompt(terminalId: string, text: unknown): boolean {
  if (!/^[\w-]{1,64}$/.test(terminalId)) return false
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_PROMPT_CHARS) return false
  appendFileSync(promptInbox(terminalId), `${JSON.stringify({ text })}\n`, { mode: 0o600 })
  return true
}

/** The file is rewritten whole on every change; past this it is not read. */
const MAX_CONVERSATION_BYTES = 8 * 1024 * 1024

function readConversation(terminalId: string): AgentConversation | null {
  try {
    const file = conversationFile(terminalId)
    const descriptor = openSync(file, 'r')
    try {
      if (fstatSync(descriptor).size > MAX_CONVERSATION_BYTES) return null
    } finally {
      closeSync(descriptor)
    }
    return parseAgentConversation(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readContext(terminalId: string): ContextUsage | null {
  try {
    return parseContextFile(readFileSync(contextFile(terminalId), 'utf8'))
  } catch {
    return null
  }
}

/** A terminal's file means nothing once it is gone, and its id is never reused. */
export function forgetContext(terminalId: string): void {
  rmSync(contextFile(terminalId), { force: true })
  rmSync(conversationFile(terminalId), { force: true })
  rmSync(promptInbox(terminalId), { force: true })
  liveConversations.delete(terminalId)
  conversationPrompts.delete(terminalId)
  conversationApprovals.delete(terminalId)
}

function readClaudeUsage(): ProviderUsage | null {
  try {
    return parseUsageFile(readFileSync(claudeUsageFile(), 'utf8'))
  } catch {
    return null
  }
}

/** A rollout can be megabytes; the newest `token_count` is always near the end. */
const ROLLOUT_TAIL_BYTES = 256 * 1024

/** Thread id to rollout path. Finding it walks the whole sessions tree, so it is done once. */
const rolloutPaths = new Map<string, string>()
const liveConversations = new Map<string, AgentConversation>()
const conversationPrompts = new Map<string, (text: string) => Promise<void>>()
const conversationApprovals = new Map<
  string,
  (approvalId: string, allow: boolean) => Promise<void>
>()

/** All live conversation sources publish through the same renderer channel and prompt route. */
export function publishAgentConversation(
  terminalId: string,
  conversation: AgentConversation,
  submitPrompt?: (text: string) => Promise<void>,
  answerApproval?: (approvalId: string, allow: boolean) => Promise<void>
): void {
  liveConversations.set(terminalId, conversation)
  if (submitPrompt) conversationPrompts.set(terminalId, submitPrompt)
  else conversationPrompts.delete(terminalId)
  if (answerApproval) conversationApprovals.set(terminalId, answerApproval)
  else conversationApprovals.delete(terminalId)
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send('agent:conversation', { terminalId, conversation })
}

/**
 * The Codex usage for a terminal's thread, read from its rollout file. Task sessions only: a bare
 * shell running `codex` has no thread id Styr knows, and a background workspace's tasks are not in
 * the index. Read on demand rather than watched — the sessions tree is large and deep.
 */
function readCodexUsage(
  terminalId: string
): { usage: ProviderUsage | null; context: ContextUsage | null } | null {
  const owner = sessionTask(terminalId)
  const session = owner ? findTask(owner.taskId)?.agentSession : undefined
  if (session?.provider !== 'codex') return null
  let path = rolloutPaths.get(session.id)
  if (!path) {
    path = codexTranscript(session.id)
    if (!path) return null
    rolloutPaths.set(session.id, path)
  }
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const length = Math.min(size, ROLLOUT_TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      return parseCodexRollout(buffer.toString('utf8'))
    } finally {
      closeSync(fd)
    }
  } catch {
    rolloutPaths.delete(session.id)
    return null
  }
}

/** Serves the last reading and pushes each new one. Read-only: the mod is the only writer. */
export function initUsage(): void {
  ipcMain.handle('usage:claude', () => readClaudeUsage())
  ipcMain.handle('usage:codex', (_event, terminalId: string) => readCodexUsage(terminalId))
  ipcMain.handle('usage:context', (_event, terminalId: string) => readContext(terminalId))
  ipcMain.handle(
    'agent:conversation',
    (_event, terminalId: string) =>
      liveConversations.get(String(terminalId)) ?? readConversation(String(terminalId))
  )
  ipcMain.handle('agent:prompt', async (_event, terminalId: string, text: unknown) => {
    const submit = conversationPrompts.get(String(terminalId))
    if (submit) {
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_PROMPT_CHARS) return false
      await submit(text)
      return true
    }
    return sendPrompt(String(terminalId), text)
  })
  ipcMain.handle(
    'agent:approval',
    async (_event, terminalId: string, approvalId: string, allow: boolean) => {
      const answer = conversationApprovals.get(String(terminalId))
      if (!answer) throw new Error('This agent conversation cannot answer approvals through Styr.')
      await answer(String(approvalId).slice(0, 200), allow === true)
    }
  )
  // Ids are not reused, so files from a previous run are only litter.
  for (const dir of [contextDir(), conversationDir(), inboxDir()]) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }
  const file = claudeUsageFile()
  mkdirSync(join(configDir(), 'usage'), { recursive: true })
  chokidar
    .watch(file, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 60 } })
    .on('add', push)
    .on('change', push)

  chokidar
    .watch(contextDir(), {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 60 }
    })
    .on('add', pushContext)
    .on('change', pushContext)

  chokidar
    .watch(conversationDir(), {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 60 }
    })
    .on('add', pushConversation)
    .on('change', pushConversation)

  function pushConversation(path: string): void {
    const terminalId = basename(path, '.json')
    const conversation = readConversation(terminalId)
    if (!conversation) return
    publishAgentConversation(terminalId, conversation)
  }

  function pushContext(path: string): void {
    const terminalId = basename(path, '.json')
    const context = readContext(terminalId)
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('usage:context', { terminalId, context })
  }

  function push(): void {
    const usage = readClaudeUsage()
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('usage:claude', usage)
  }
}
