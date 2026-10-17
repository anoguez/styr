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
import chokidar from 'chokidar'
import { configDir } from '@core/config.js'
import {
  approvalOptions,
  parseAgentConversation,
  type AgentConversation
} from '@core/agentConversation.js'
import {
  parseCodexRollout,
  parseContextFile,
  parseUsageFile,
  type ContextUsage,
  type ProviderUsage
} from '@core/usage.js'
import type { Task } from '@core/types.js'
import type { HostPorts } from './ports.js'

export interface UsagePorts extends Pick<HostPorts, 'broadcast' | 'appPaths'> {
  /** The task a terminal runs, from the terminals service. */
  sessionTask(terminalId: string): { taskId: string } | undefined
  /** A task of the active board, from the index. */
  findTask(taskId: string): Task | null | undefined
  /** Where Codex keeps a thread's rollout (`codexTranscript`). */
  codexTranscript(threadId: string): string | undefined
  /** Calls `onChange` with the path of each file added or rewritten (`watchFiles`). */
  watch(path: string, options: { depth?: number }, onChange: (path: string) => void): void
}

/** Watches with chokidar, reporting a file once its writer has finished with it. */
export function watchFiles(
  path: string,
  options: { depth?: number },
  onChange: (path: string) => void
): void {
  chokidar
    .watch(path, { ignoreInitial: true, ...options, awaitWriteFinish: { stabilityThreshold: 60 } })
    .on('add', onChange)
    .on('change', onChange)
}

/** Longest prompt sent through the inbox. */
export const MAX_PROMPT_CHARS = 100_000

/** Account-wide, so it lives beside the global config, not in a workspace. */
const claudeUsageFile = (): string => join(configDir(), 'usage', 'claude.json')

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

/** The file is rewritten whole on every change; past this it is not read. */
const MAX_CONVERSATION_BYTES = 8 * 1024 * 1024

/** A rollout can be megabytes; the newest `token_count` is always near the end. */
const ROLLOUT_TAIL_BYTES = 256 * 1024

/** Answers an approval through the agent's own channel, by the option picked. */
type ApprovalAnswer = (approvalId: string, optionId: string) => Promise<void>

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

function readClaudeUsage(): ProviderUsage | null {
  try {
    return parseUsageFile(readFileSync(claudeUsageFile(), 'utf8'))
  } catch {
    return null
  }
}

/** Appends a prompt for the agent in `terminalId`; false when it is not one to send. */
export function sendPrompt(terminalId: string, text: unknown): boolean {
  if (!/^[\w-]{1,64}$/.test(terminalId)) return false
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_PROMPT_CHARS) return false
  appendFileSync(promptInbox(terminalId), `${JSON.stringify({ text })}\n`, { mode: 0o600 })
  return true
}

/**
 * Answers the approval the conversation file shows through the inbox, as an `{"approval", "option"}`
 * line the agent's side reads (Claude Code's mod answers its permission request with it). Refused
 * when the file no longer shows that approval or that option: it was answered in the CLI's view.
 */
export function sendApprovalAnswer(terminalId: string, approvalId: string, optionId: string): void {
  if (!/^[\w-]{1,64}$/.test(terminalId)) throw new Error('Not an agent terminal.')
  const approval = readConversation(terminalId)?.approval
  if (
    !approval ||
    approval.id !== approvalId ||
    !approvalOptions(approval).some((o) => o.id === optionId)
  )
    throw new Error('This approval is no longer waiting for a decision.')
  appendFileSync(
    promptInbox(terminalId),
    `${JSON.stringify({ approval: approvalId, option: optionId })}\n`,
    { mode: 0o600 }
  )
}

/**
 * The agent CLIs' usage and conversations: the account's quota and each terminal's context fill
 * (written by Claude Code's usage mod, or read from a Codex rollout), the conversation Styr
 * Terminal draws as blocks, and the prompts and approvals sent back to the agent. Read-only on the
 * mod's files; it only appends to a terminal's prompt inbox.
 */
export function createUsage(ports: UsagePorts) {
  /** Plain files beside the asar when packaged (`extraResources`): Claude Code cannot read an asar. */
  function claudeModsRoot(): string {
    const { appPaths } = ports
    return appPaths.isPackaged
      ? join(appPaths.resourcesPath, 'claude')
      : join(appPaths.appPath, 'resources', 'claude')
  }

  /**
   * Environment that makes a Claude Code started in a Styr terminal load the usage mod and say where
   * to write. Added to every terminal, not just agent sessions: a shell tab can run `claude` too.
   * Any plugin folders the user already exports are kept, after this one.
   */
  function usageEnv(existing: string | undefined, terminalId: string): Record<string, string> {
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

  /** Thread id to rollout path. Finding it walks the whole sessions tree, so it is done once. */
  const rolloutPaths = new Map<string, string>()
  const liveConversations = new Map<string, AgentConversation>()
  const conversationPrompts = new Map<string, (text: string) => Promise<void>>()
  const conversationApprovals = new Map<string, ApprovalAnswer>()

  /** A terminal's file means nothing once it is gone, and its id is never reused. */
  function forgetContext(terminalId: string): void {
    rmSync(contextFile(terminalId), { force: true })
    rmSync(conversationFile(terminalId), { force: true })
    rmSync(promptInbox(terminalId), { force: true })
    liveConversations.delete(terminalId)
    conversationPrompts.delete(terminalId)
    conversationApprovals.delete(terminalId)
  }

  /** All live conversation sources publish through the same renderer channel and prompt route. */
  function publishAgentConversation(
    terminalId: string,
    conversation: AgentConversation,
    submitPrompt?: (text: string) => Promise<void>,
    answerApproval?: ApprovalAnswer
  ): void {
    liveConversations.set(terminalId, conversation)
    if (submitPrompt) conversationPrompts.set(terminalId, submitPrompt)
    else conversationPrompts.delete(terminalId)
    if (answerApproval) conversationApprovals.set(terminalId, answerApproval)
    else conversationApprovals.delete(terminalId)
    ports.broadcast('agent:conversation', { terminalId, conversation })
  }

  /**
   * The Codex usage for a terminal's thread, read from its rollout file. Task sessions only: a bare
   * shell running `codex` has no thread id Styr knows, and a background workspace's tasks are not in
   * the index. Read on demand rather than watched — the sessions tree is large and deep.
   */
  function codexUsage(
    terminalId: string
  ): { usage: ProviderUsage | null; context: ContextUsage | null } | null {
    const owner = ports.sessionTask(terminalId)
    const session = owner ? ports.findTask(owner.taskId)?.agentSession : undefined
    if (session?.provider !== 'codex') return null
    let path = rolloutPaths.get(session.id)
    if (!path) {
      path = ports.codexTranscript(session.id)
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

  /** The conversation a terminal's agent view shows: the live one, else the mod's file. */
  function conversation(terminalId: string): AgentConversation | null {
    return liveConversations.get(terminalId) ?? readConversation(terminalId)
  }

  /** Sends a prompt typed in Styr to the agent: through its own channel when it has one, else the inbox. */
  async function prompt(terminalId: string, text: unknown): Promise<boolean> {
    const submit = conversationPrompts.get(terminalId)
    if (submit) {
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_PROMPT_CHARS) return false
      // Refused (a turn already running, the daemon gone): false, so the view types it instead.
      return submit(text).then(
        () => true,
        () => false
      )
    }
    return sendPrompt(terminalId, text)
  }

  /** Answers an approval the agent is waiting on, by the option picked. */
  async function approval(terminalId: string, approvalId: string, optionId: string): Promise<void> {
    const id = approvalId.slice(0, 200)
    const option = optionId.slice(0, 32)
    const answer = conversationApprovals.get(terminalId)
    if (answer) await answer(id, option)
    else sendApprovalAnswer(terminalId, id, option)
  }

  /**
   * Clears the files a previous run left and pushes each new reading. Read-only: the mod is the only
   * writer. Called once, after the handlers are registered.
   */
  function start(): void {
    // Ids are not reused, so files from a previous run are only litter.
    for (const dir of [contextDir(), conversationDir(), inboxDir()]) {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
    }
    const file = claudeUsageFile()
    mkdirSync(join(configDir(), 'usage'), { recursive: true })
    ports.watch(file, {}, push)
    ports.watch(contextDir(), { depth: 0 }, pushContext)
    ports.watch(conversationDir(), { depth: 0 }, pushConversation)
  }

  function pushConversation(path: string): void {
    const terminalId = basename(path, '.json')
    const conversation = readConversation(terminalId)
    if (!conversation) return
    publishAgentConversation(terminalId, conversation)
  }

  function pushContext(path: string): void {
    const terminalId = basename(path, '.json')
    const context = readContext(terminalId)
    ports.broadcast('usage:context', { terminalId, context })
  }

  function push(): void {
    ports.broadcast('usage:claude', readClaudeUsage())
  }

  return {
    usageEnv,
    forgetContext,
    publishAgentConversation,
    claudeUsage: readClaudeUsage,
    codexUsage,
    context: readContext,
    conversation,
    prompt,
    approval,
    start
  }
}

export type Usage = ReturnType<typeof createUsage>
