import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { agentsDir, supportDir } from '../agentStore.js'
import { shellQuote } from '../shell.js'
import type { Settings } from '../types.js'
import type { AgentProvider } from './types.js'

/**
 * Claude Code writes transcripts to ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl.
 * Matching the exact filename avoids depending on how it encodes the directory name.
 */
function findTranscript(sessionId: string, root = homedir()): string | undefined {
  const projects = join(root, '.claude', 'projects')
  if (!existsSync(projects)) return undefined
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${sessionId}.jsonl`)
    if (existsSync(file)) return file
  }
  return undefined
}

/**
 * Hook command that records one lifecycle event. Pure POSIX shell so it never depends on
 * node or jq being on PATH: it wraps the hook's stdin payload verbatim and lets the app
 * parse it. Writes to a temp file then renames, so the watcher never sees a half-written file.
 */
function hookCommand(dir: string, taskId: string, event: string): string {
  const target = join(dir, `${taskId}.json`)
  const temp = join(dir, `.${taskId}.${event}.tmp`)
  return (
    `p=$(cat); printf '{"taskId":"%s","event":"%s","at":"%s","payload":%s}\\n' ` +
    `'${taskId}' '${event}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\${p:-null}" > '${temp}' ` +
    `&& mv '${temp}' '${target}'`
  )
}

/**
 * Only the notifications that need you. `idle_prompt` (still at the prompt a minute after `Stop`)
 * is left out: it would overwrite the `Stop` record, and with it the turn's last message, to say
 * nothing new.
 */
const NOTIFICATION_MATCHER = 'permission_prompt|elicitation_dialog'

export function buildHookSettings(settings: Settings, taskId: string): string {
  const dir = agentsDir(settings)
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop']
  const hooks = Object.fromEntries(
    events.map((event) => [
      event,
      [
        {
          ...(event === 'Notification' ? { matcher: NOTIFICATION_MATCHER } : {}),
          hooks: [{ type: 'command', command: hookCommand(dir, taskId, event) }]
        }
      ]
    ])
  )
  return JSON.stringify({ hooks }, null, 2)
}

/** Hook settings are merged on top of the user's own — `--settings` loads additional settings. */
function writeHookSettings(settings: Settings, taskId: string): string {
  const file = join(supportDir(settings, 'hooks'), `${taskId}.json`)
  writeFileSync(file, buildHookSettings(settings, taskId), 'utf8')
  return file
}

export const claudeProvider: AgentProvider = {
  id: 'claude',
  label: 'Claude Code',

  buildCommand({ settings, taskId, sessionId, resume, forkFrom, prompt }) {
    const hookArg = `--settings '${shellQuote(writeHookSettings(settings, taskId))}'`
    // `--session-id` is only accepted beside `--resume` together with `--fork-session`, which is what
    // lets a fork's id be known before the CLI starts.
    const sessionArg = forkFrom
      ? `--resume ${forkFrom} --fork-session --session-id ${sessionId}`
      : resume
        ? `--resume ${sessionId}`
        : `--session-id ${sessionId}`
    const promptArg = prompt ? ` ${prompt}` : ''
    // Auto mode hands permission prompts to Claude Code's classifier; it is not bypassPermissions.
    const modeArg = settings.claudeApprovalMode === 'auto' ? ' --permission-mode auto' : ''
    return `${settings.claudeCommand} ${hookArg}${modeArg} ${sessionArg}${promptArg}`
  },

  newSessionId: () => randomUUID(),

  sessionExists: (sessionId, homeRoot) => findTranscript(sessionId, homeRoot) !== undefined,

  sessionTime(sessionId, homeRoot) {
    const file = findTranscript(sessionId, homeRoot)
    return file ? new Date(statSync(file).mtimeMs).toISOString() : undefined
  },

  mcpInstallCommand: (serverEntry) =>
    `claude mcp add styr --scope user -- node '${shellQuote(serverEntry)}'`,

  // Inherited, these make a launched `claude` treat itself as a child of the parent session: it
  // turns transcript saving off, so the next launch finds no transcript and starts a fresh chat
  // instead of resuming. CLAUDE_CODE_* settings such as CLAUDE_CODE_USE_BEDROCK are left alone.
  sessionEnvKeys: [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_PID'
  ]
}
