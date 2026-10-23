import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import type { ShellSyntax } from '../shell.js'
import type { Settings } from '../types.js'
import { parseMcpGet } from './mcpGet.js'
import type { AgentProvider, TranscriptUsage, TranscriptUsageReader } from './types.js'

function sessionDirectory(root: string): string {
  return join(root, '.codex', 'sessions')
}

function sessionFiles(path: string): string[] {
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const file = join(path, entry.name)
    return entry.isDirectory() ? sessionFiles(file) : [file]
  })
}

export function codexTranscript(id: string, root = homedir()): string | undefined {
  return sessionFiles(sessionDirectory(root)).find((file) => file.includes(id))
}

/** A rollout's own thread id and the thread that started it, from its `session_meta` line. */
interface RolloutThread {
  id?: string
  parent?: string
}

/**
 * Each rollout's thread, by file. A `session_meta` line is written once and never changes, so a file
 * is read for it at most once per process — once its first line is complete.
 */
const rolloutThreads = new Map<string, RolloutThread | null>()

/** The first line of `file`, or undefined while it is still being written. */
function firstLine(file: string): string | undefined {
  const chunk = Buffer.alloc(64 * 1024)
  const parts: Buffer[] = []
  const descriptor = openSync(file, 'r')
  try {
    for (let offset = 0; ;) {
      const got = readSync(descriptor, chunk, 0, chunk.length, offset)
      if (got === 0) return undefined
      const end = chunk.subarray(0, got).indexOf(0x0a)
      if (end >= 0) {
        parts.push(Buffer.from(chunk.subarray(0, end)))
        return Buffer.concat(parts).toString('utf8')
      }
      parts.push(Buffer.from(chunk.subarray(0, got)))
      offset += got
    }
  } finally {
    closeSync(descriptor)
  }
}

function rolloutThread(file: string): RolloutThread | null {
  const known = rolloutThreads.get(file)
  if (known !== undefined) return known
  let line: string | undefined
  try {
    line = firstLine(file)
  } catch {
    return null
  }
  if (line === undefined) return null
  let thread: RolloutThread | null = null
  try {
    const record = JSON.parse(line) as {
      type?: string
      payload?: { id?: string; parent_thread_id?: string }
    }
    if (record.type === 'session_meta')
      thread = { id: record.payload?.id, parent: record.payload?.parent_thread_id }
  } catch {
    // Not a rollout; never one later either.
  }
  rolloutThreads.set(file, thread)
  return thread
}

function sortedEntries(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

/**
 * The rollouts in the date folders (`YYYY/MM/DD`) from `from`'s onward; all of them when `from`
 * is not dated.
 */
function rolloutsFrom(sessions: string, from: readonly string[]): string[] {
  const files: string[] = []
  const walk = (dir: string, depth: number, after: boolean): void => {
    for (const name of sortedEntries(dir)) {
      const path = join(dir, name)
      if (depth === 3) {
        if (name.endsWith('.jsonl')) files.push(path)
        continue
      }
      const bound = from[depth]
      if (!after && bound !== undefined && name < bound) continue
      walk(path, depth + 1, after || bound === undefined || name > bound)
    }
  }
  walk(sessions, 0, false)
  return files
}

/**
 * The child threads a Codex thread started, and theirs: rollouts whose `session_meta` names it (or
 * one of them) as `parent_thread_id` — guardian reviews and spawned agents alike. A child never
 * starts before its parent, so only the date folders from the parent rollout's onward are walked.
 */
export function codexSubagentTranscripts(
  sessionId: string,
  transcript: string,
  root = homedir()
): string[] {
  const sessions = sessionDirectory(root)
  const parts = relative(sessions, transcript).split(sep)
  const dated = parts.length === 4 && parts.slice(0, 3).every((part) => /^\d+$/.test(part))
  const candidates = rolloutsFrom(sessions, dated ? parts.slice(0, 3) : [])
    .filter((file) => file !== transcript)
    .map((file) => ({ file, thread: rolloutThread(file) }))
  const threads = new Set([sessionId])
  const children = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const { file, thread } of candidates) {
      if (children.has(file) || !thread?.parent || !threads.has(thread.parent)) continue
      children.add(file)
      if (thread.id) threads.add(thread.id)
      grew = true
    }
  }
  return candidates.map(({ file }) => file).filter((file) => children.has(file))
}

interface CodexTokenCount {
  timestamp?: string
  payload?: {
    type?: string
    info?: {
      total_token_usage?: {
        input_tokens?: number
        cached_input_tokens?: number
        output_tokens?: number
      }
    } | null
  }
}

/**
 * The model calls in a Codex rollout. Its `token_count` events carry the session's running total
 * (and repeat it unchanged at times), so each call is what that total grew by. Codex counts cached
 * input inside `input_tokens`, so it is taken back out.
 */
export function codexUsageReader(): TranscriptUsageReader {
  let total = 0
  return (text) => {
    const calls: TranscriptUsage[] = []
    for (const line of text.split('\n')) {
      if (!line.includes('"token_count"')) continue
      let record: CodexTokenCount
      try {
        record = JSON.parse(line) as CodexTokenCount
      } catch {
        continue
      }
      const usage =
        record.payload?.type === 'token_count' ? record.payload.info?.total_token_usage : undefined
      const at = Date.parse(record.timestamp ?? '')
      if (!usage || !Number.isFinite(at)) continue
      const running =
        (usage.input_tokens ?? 0) - (usage.cached_input_tokens ?? 0) + (usage.output_tokens ?? 0)
      if (running > total) calls.push({ at, tokens: running - total })
      total = running
    }
    return calls
  }
}

/** Every model call in a whole Codex rollout. */
export function codexTranscriptUsage(text: string): TranscriptUsage[] {
  return codexUsageReader()(text)
}

export interface CodexCommandInput {
  sessionId: string
  resume: boolean
  /** Fork this thread into a new one. The TUI creates the new thread, so its id is learned later. */
  forkFrom?: string
  /** The directory the thread works in. A remote TUI does not inherit the shell's. */
  cwd: string
  /** The model to run; undefined leaves Codex's configured default. */
  model?: string
  prompt?: string
  /** The syntax of the shell the command is typed into. */
  syntax: ShellSyntax
}

/**
 * The TUI runs against the shared app-server daemon (`--remote unix://`, its default socket) so the
 * thread lives where Styr's monitor can watch it. `--cd` is required there: the daemon, not the
 * terminal, decides a new thread's directory.
 */
export function codexCommand(
  settings: Pick<Settings, 'codexCommand' | 'codexApprovalReviewer'>,
  { sessionId, resume, forkFrom, cwd, model, prompt, syntax }: CodexCommandInput
): string {
  const codex = syntax.invoke(settings.codexCommand)
  const modelArg = model ? ` --model ${syntax.quote(model)}` : ''
  const daemonArgs = `--remote unix:// --cd ${syntax.quote(cwd)}${modelArg}`
  if (resume) return `${codex} resume ${daemonArgs} ${sessionId}${prompt ? ` ${prompt}` : ''}`

  // `--approve-for-me` brings its own workspace-write sandbox and codex rejects it alongside `--sandbox`.
  // The sandbox blocks the network by default, which stops `gh` and `git push` — the board protocol
  // has agents push and open a PR — so network is opened inside it. Files stay confined.
  const network = '-c sandbox_workspace_write.network_access=true'
  const policy =
    settings.codexApprovalReviewer === 'auto_review'
      ? `--approve-for-me ${network}`
      : `--sandbox workspace-write --ask-for-approval on-request ${network}`
  if (forkFrom)
    return `${codex} fork ${daemonArgs} ${policy} ${forkFrom}${prompt ? ` ${prompt}` : ''}`
  return `${codex} ${daemonArgs} ${policy} ${prompt ?? syntax.quote('')}`
}

export const codexProvider: AgentProvider = {
  id: 'codex',
  label: 'Codex',
  newSessionId: () => randomUUID(),
  buildCommand({ settings, sessionId, resume, forkFrom, cwd, model, prompt, syntax }) {
    return codexCommand(settings, { sessionId, resume, forkFrom, cwd, model, prompt, syntax })
  },
  sessionExists: (id, root) => codexTranscript(id, root) !== undefined,
  transcriptPath: codexTranscript,
  subagentTranscripts: codexSubagentTranscripts,
  transcriptUsageReader: codexUsageReader,
  sessionTime: (id, root) => {
    const file = codexTranscript(id, root)
    return file ? new Date(statSync(file).mtimeMs).toISOString() : undefined
  },
  command: (settings) => settings.codexCommand,
  installCommand: () => 'npm install -g @openai/codex',
  mcpInstallCommand: (entry, syntax) =>
    `codex mcp add styr --env STYR_MCP_AUTHOR=codex -- node ${syntax.quote(entry)}`,
  mcpRemoveCommand: () => 'codex mcp remove styr',
  mcpProbeCommand: (command, syntax) => `${syntax.invoke(command)} mcp get styr`,
  parseMcpRegistration: (result) => parseMcpGet(result, /^\s*args:\s*(.+)$/m),
  sessionEnvKeys: ['CODEX_THREAD_ID', 'CODEX_SESSION_ID']
}
