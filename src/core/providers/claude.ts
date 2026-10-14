import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SUBAGENT_EVENTS } from '../agentState.js'
import { agentsDir, subagentsDir, supportDir } from '../agentStore.js'
import type { Settings } from '../types.js'
import type { AgentProvider, TranscriptUsage } from './types.js'

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

interface ClaudeUsageRecord {
  timestamp?: string
  message?: {
    id?: string
    usage?: {
      input_tokens?: number
      cache_creation_input_tokens?: number
      output_tokens?: number
    }
  }
}

/**
 * The model calls in a Claude Code transcript. One assistant message is written as several records
 * (a line per content block), each carrying the message's usage, so a message counts once, at its
 * first record, with the largest usage any of its records reports.
 */
export function claudeTranscriptUsage(text: string): TranscriptUsage[] {
  const byId = new Map<string, TranscriptUsage>()
  const calls: TranscriptUsage[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let record: ClaudeUsageRecord
    try {
      record = JSON.parse(line) as ClaudeUsageRecord
    } catch {
      continue
    }
    const usage = record.message?.usage
    const at = Date.parse(record.timestamp ?? '')
    if (!usage || !Number.isFinite(at)) continue
    const tokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.output_tokens ?? 0)
    const id = record.message?.id
    const seen = id ? byId.get(id) : undefined
    if (seen) {
      seen.tokens = Math.max(seen.tokens, tokens)
      continue
    }
    const call: TranscriptUsage = id ? { at, tokens, id } : { at, tokens }
    if (id) byId.set(id, call)
    calls.push(call)
  }
  return calls
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
 * The same record into the task's subagent folder, each event under its own name (seconds plus the
 * hook shell's pid) so parallel subagents stopping at once never collide. The app, not the hook,
 * reads `agent_id` out of the payload.
 */
function subagentHookCommand(dir: string, taskId: string, event: string): string {
  // `$$` must sit outside the single quotes to expand, so the path is quoted in pieces.
  const temp = `'${join(dir, `.${event}.`)}'"$$"'.tmp'`
  const target = `'${dir}${sep}'"$(date +%s)-$$-${event}.json"`
  return (
    `p=$(cat); mkdir -p '${dir}' && printf '{"taskId":"%s","event":"%s","at":"%s","payload":%s}\\n' ` +
    `'${taskId}' '${event}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\${p:-null}" > ${temp} ` +
    `&& mv ${temp} ${target}`
  )
}

/**
 * Only the notifications that need you. `idle_prompt` (still at the prompt a minute after `Stop`)
 * is left out: it would overwrite the `Stop` record, and with it the turn's last message, to say
 * nothing new.
 */
const NOTIFICATION_MATCHER = 'permission_prompt|elicitation_dialog'

/**
 * Parent events go to the task's status file. Subagent starts and stops go only to the subagent
 * folder, and so does `UserPromptSubmit` a second time: it marks the turn that clears done rows.
 */
export function buildHookSettings(settings: Settings, taskId: string): string {
  const dir = agentsDir(settings)
  const subagents = subagentsDir(settings, taskId)
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop']
  const command = (text: string): { type: string; command: string } => ({
    type: 'command',
    command: text
  })
  const hooks: Record<string, unknown[]> = Object.fromEntries(
    events.map((event) => [
      event,
      [
        {
          ...(event === 'Notification' ? { matcher: NOTIFICATION_MATCHER } : {}),
          hooks: [
            command(hookCommand(dir, taskId, event)),
            ...(event === 'UserPromptSubmit'
              ? [command(subagentHookCommand(subagents, taskId, event))]
              : [])
          ]
        }
      ]
    ])
  )
  for (const event of SUBAGENT_EVENTS)
    hooks[event] = [{ hooks: [command(subagentHookCommand(subagents, taskId, event))] }]
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

  buildCommand({ settings, taskId, sessionId, resume, forkFrom, model, prompt, syntax }) {
    const hookArg = `--settings ${syntax.quote(writeHookSettings(settings, taskId))}`
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
    // Passed on resume too: `--model` sets the session's model, so a changed choice takes effect.
    const modelArg = model ? ` --model ${syntax.quote(model)}` : ''
    return `${syntax.invoke(settings.claudeCommand)} ${hookArg}${modeArg}${modelArg} ${sessionArg}${promptArg}`
  },

  newSessionId: () => randomUUID(),

  sessionExists: (sessionId, homeRoot) => findTranscript(sessionId, homeRoot) !== undefined,
  transcriptPath: findTranscript,
  transcriptUsage: claudeTranscriptUsage,

  sessionTime(sessionId, homeRoot) {
    const file = findTranscript(sessionId, homeRoot)
    return file ? new Date(statSync(file).mtimeMs).toISOString() : undefined
  },

  command: (settings) => settings.claudeCommand,
  installCommand: (platform) =>
    platform === 'win32'
      ? 'irm https://claude.ai/install.ps1 | iex'
      : 'curl -fsSL https://claude.ai/install.sh | bash',

  mcpInstallCommand: (serverEntry, syntax) =>
    `claude mcp add styr --scope user -- node ${syntax.quote(serverEntry)}`,

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
