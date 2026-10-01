import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shellQuote } from '../shell.js'
import type { AgentProvider } from './types.js'

function transcript(id: string, root = homedir()): string | undefined {
  const dir = join(root, '.codex', 'sessions')
  if (!existsSync(dir)) return undefined
  const visit = (path: string): string | undefined => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) {
        const found = visit(file)
        if (found) return found
      } else if (entry.name.includes(id)) return file
    }
  }
  return visit(dir)
}

export const codexProvider: AgentProvider = {
  id: 'codex',
  label: 'Codex',
  newSessionId: () => randomUUID(),
  buildCommand({ settings, sessionId, resume, prompt }) {
    const base = settings.codexCommand
    const args = `--sandbox workspace-write --ask-for-approval on-request`
    return resume
      ? `${base} resume ${args} ${sessionId}${prompt ? ` ${prompt}` : ''}`
      : `${base} ${args} ${prompt ?? `''`}`
  },
  sessionExists: (id, root) => transcript(id, root) !== undefined,
  sessionTime: (id, root) => {
    const file = transcript(id, root)
    return file ? new Date(statSync(file).mtimeMs).toISOString() : undefined
  },
  mcpInstallCommand: (entry) => `codex mcp add styr -- node '${shellQuote(entry)}'`,
  sessionEnvKeys: ['CODEX_THREAD_ID', 'CODEX_SESSION_ID']
}
