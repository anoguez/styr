import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ShellSyntax } from '../shell.js'
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

export function codexTranscript(id: string, root = homedir()): string | undefined {
  return sessionFiles(sessionDirectory(root)).find((file) => file.includes(id))
}

export interface CodexCommandInput {
  sessionId: string
  resume: boolean
  /** Fork this thread into a new one. The TUI creates the new thread, so its id is learned later. */
  forkFrom?: string
  /** The directory the thread works in. A remote TUI does not inherit the shell's. */
  cwd: string
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
  { sessionId, resume, forkFrom, cwd, prompt, syntax }: CodexCommandInput
): string {
  const codex = syntax.invoke(settings.codexCommand)
  const daemonArgs = `--remote unix:// --cd ${syntax.quote(cwd)}`
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
  buildCommand({ settings, sessionId, resume, forkFrom, cwd, prompt, syntax }) {
    return codexCommand(settings, { sessionId, resume, forkFrom, cwd, prompt, syntax })
  },
  sessionExists: (id, root) => codexTranscript(id, root) !== undefined,
  sessionTime: (id, root) => {
    const file = codexTranscript(id, root)
    return file ? new Date(statSync(file).mtimeMs).toISOString() : undefined
  },
  command: (settings) => settings.codexCommand,
  installCommand: () => 'npm install -g @openai/codex',
  mcpInstallCommand: (entry, syntax) =>
    `codex mcp add styr --env STYR_MCP_AUTHOR=codex -- node ${syntax.quote(entry)}`,
  sessionEnvKeys: ['CODEX_THREAD_ID', 'CODEX_SESSION_ID']
}
