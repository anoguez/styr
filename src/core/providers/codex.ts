import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shellQuote } from '../shell.js'
import type { Settings } from '../types.js'
import type { AgentProvider } from './types.js'

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

function transcript(id: string, root = homedir()): string | undefined {
  return sessionFiles(sessionDirectory(root)).find((file) => file.includes(id))
}

export interface CodexCommandInput {
  sessionId: string
  resume: boolean
  /** The directory the thread works in. A remote TUI does not inherit the shell's. */
  cwd: string
  prompt?: string
}

/**
 * The TUI runs against the shared app-server daemon (`--remote unix://`, its default socket) so the
 * thread lives where Styr's monitor can watch it. `--cd` is required there: the daemon, not the
 * terminal, decides a new thread's directory.
 */
export function codexCommand(
  settings: Pick<Settings, 'codexCommand' | 'codexApprovalReviewer'>,
  { sessionId, resume, cwd, prompt }: CodexCommandInput
): string {
  // `--approve-for-me` brings its own workspace-write sandbox and codex rejects it alongside `--sandbox`.
  const policy =
    settings.codexApprovalReviewer === 'auto_review'
      ? '--approve-for-me'
      : '--sandbox workspace-write --ask-for-approval on-request'
  const args = `--remote unix:// --cd '${shellQuote(cwd)}' ${policy}`
  return resume
    ? `${settings.codexCommand} resume ${args} ${sessionId}${prompt ? ` ${prompt}` : ''}`
    : `${settings.codexCommand} ${args} ${prompt ?? `''`}`
}

export const codexProvider: AgentProvider = {
  id: 'codex',
  label: 'Codex',
  newSessionId: () => randomUUID(),
  buildCommand({ settings, sessionId, resume, cwd, prompt }) {
    return codexCommand(settings, { sessionId, resume, cwd, prompt })
  },
  sessionExists: (id, root) => transcript(id, root) !== undefined,
  sessionTime: (id, root) => {
    const file = transcript(id, root)
    return file ? new Date(statSync(file).mtimeMs).toISOString() : undefined
  },
  mcpInstallCommand: (entry) =>
    `codex mcp add styr --env STYR_MCP_AUTHOR=codex -- node '${shellQuote(entry)}'`,
  sessionEnvKeys: ['CODEX_THREAD_ID', 'CODEX_SESSION_ID']
}
