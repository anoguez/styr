import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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

interface SessionMeta {
  type?: string
  timestamp?: string
  payload?: { id?: string; cwd?: string }
}

/**
 * The interactive CLI chooses its own thread UUID. Find that newly-created local transcript so
 * Styr stores a real id that `codex resume` can open later.
 */
export function newestCodexSessionFor(
  cwd: string,
  startedAfter: string,
  root = homedir()
): string | undefined {
  const earliest = Date.parse(startedAfter)
  const candidates = sessionFiles(sessionDirectory(root)).flatMap((file) => {
    try {
      const firstLine = readFileSync(file, 'utf8').split('\n', 1)[0]
      if (!firstLine) return []
      const meta = JSON.parse(firstLine) as SessionMeta
      const id = meta.type === 'session_meta' ? meta.payload?.id : undefined
      const startedAt = meta.timestamp ? Date.parse(meta.timestamp) : Number.NaN
      return id && meta.payload?.cwd === cwd && startedAt >= earliest ? [{ id, startedAt }] : []
    } catch {
      return []
    }
  })
  return candidates.sort((left, right) => right.startedAt - left.startedAt)[0]?.id
}

export function codexCommand(
  settings: Pick<Settings, 'codexCommand' | 'codexApprovalReviewer'>,
  sessionId: string,
  resume: boolean,
  prompt?: string
): string {
  const approval =
    settings.codexApprovalReviewer === 'auto_review'
      ? '--approve-for-me'
      : '--ask-for-approval on-request'
  const args = `--sandbox workspace-write ${approval}`
  return resume
    ? `${settings.codexCommand} resume ${args} ${sessionId}${prompt ? ` ${prompt}` : ''}`
    : `${settings.codexCommand} ${args} ${prompt ?? `''`}`
}

export const codexProvider: AgentProvider = {
  id: 'codex',
  label: 'Codex',
  newSessionId: () => randomUUID(),
  buildCommand({ settings, sessionId, resume, prompt }) {
    return codexCommand(settings, sessionId, resume, prompt)
  },
  sessionExists: (id, root) => transcript(id, root) !== undefined,
  sessionTime: (id, root) => {
    const file = transcript(id, root)
    return file ? new Date(statSync(file).mtimeMs).toISOString() : undefined
  },
  mcpInstallCommand: (entry) => `codex mcp add styr -- node '${shellQuote(entry)}'`,
  sessionEnvKeys: ['CODEX_THREAD_ID', 'CODEX_SESSION_ID']
}
