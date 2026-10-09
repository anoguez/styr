import { AGENT_PROVIDER_PROGRAMS, type ActivityEntry, type TaskStatus } from './types.js'
import { AGENT_PROVIDER_IDS, type AgentProviderId } from './providers/types.js'

export interface HandoffSource {
  id: string
  title: string
  status: TaskStatus
  description: string
  activity: ActivityEntry[]
}

export interface HandoffInput {
  /** The task the session was working on, when it was a task session. */
  source?: HandoffSource
  cwd: string
  branch?: string
  /** `git status --short`, `git diff HEAD --stat` and `git log --oneline` of `cwd`. */
  status: string
  diffStat: string
  commits: string
  /** The tail of the terminal, as plain text. */
  output: string
  createdAt: string
  /** The agent has been asked to write its own summary into the "Agent summary" section. */
  awaitingAgentSummary?: boolean
}

/** Agent CLIs a shell may be running; typing a request into anything else would run it as a command. */
export function isAgentProgram(command: string | undefined): boolean {
  return agentProgramProvider(command) !== undefined
}

/** The agent CLI a command line starts, by its program's name; undefined for anything else. */
export function agentProgramProvider(command: string | undefined): AgentProviderId | undefined {
  if (!command) return undefined
  const program = command.trim().split(/\s+/)[0] ?? ''
  // `/` on macOS; `\` or `.exe` when a Windows shell names the program by path.
  const name = (program.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '')
  return AGENT_PROVIDER_IDS.find((id) => AGENT_PROVIDER_PROGRAMS[id] === name)
}

export const AGENT_SUMMARY_HEADING = '## Agent summary'
export const AGENT_SUMMARY_PENDING =
  '_Pending: the previous agent was asked to write this. If this line is still here, it did not._'

/**
 * The one-line request typed into the running agent. One line, because a newline in a TUI input
 * submits it; the path is quoted because the workspace folder can contain spaces.
 */
export function agentHandoffPrompt(path: string): string {
  return (
    `Please write a handoff for the next agent. Open \`${path}\` and replace the pending line under ` +
    `"${AGENT_SUMMARY_HEADING}" with: what is done, what remains, decisions and why, pitfalls, and ` +
    'how to verify. Edit only that section and keep it concise. Reply "handoff written" when finished.'
  )
}

const MAX_OUTPUT_LINES = 120
const MAX_ACTIVITY = 15

function fenced(text: string, empty: string): string {
  // Leading spaces matter in `git status --short`, so only blank lines and the tail are trimmed.
  const body = text.replace(/^\n+/, '').trimEnd()
  return ['```', body || empty, '```'].join('\n')
}

function tail(text: string): string {
  const lines = text.trimEnd().split('\n')
  return lines.slice(-MAX_OUTPUT_LINES).join('\n')
}

/** `TASK-0019-20261004-114500.md`, or `shell-…` for a session with no task. */
export function handoffFileName(source: HandoffSource | undefined, createdAt: string): string {
  const stamp = createdAt.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  return `${source?.id ?? 'shell'}-${stamp}.md`
}

/**
 * The document one agent leaves for the next. It states only what Styr can observe — the task, the
 * branch, the checkout's state and what the terminal last printed — and says so, so the receiving
 * agent verifies it instead of trusting a summary nobody wrote.
 */
export function renderHandoff(input: HandoffInput): string {
  const { source } = input
  const lines = [
    `# Handoff${source ? `: ${source.title}` : ''}`,
    '',
    `Written by Styr on ${input.createdAt}. This is a snapshot of the previous session's workspace, ` +
      'not a summary written by that agent. Confirm the state below with git before relying on it.',
    '',
    '## Where the work is',
    '',
    `- Directory: \`${input.cwd}\``
  ]
  if (input.branch) lines.push(`- Branch: \`${input.branch}\``)
  if (source) lines.push(`- Source task: ${source.id} (${source.status.replace('_', ' ')})`)

  if (input.awaitingAgentSummary) lines.push('', AGENT_SUMMARY_HEADING, '', AGENT_SUMMARY_PENDING)

  if (source?.description.trim()) lines.push('', '## Task spec', '', source.description.trim())

  const notes = source?.activity.slice(-MAX_ACTIVITY) ?? []
  if (notes.length > 0) {
    lines.push('', '## Activity so far', '')
    for (const note of notes)
      lines.push(`- ${note.at ? `${note.at} ` : ''}${note.author}: ${note.message}`.trim())
  }

  lines.push(
    '',
    '## Repository state',
    '',
    '### Uncommitted changes',
    fenced(input.status, '(clean)'),
    '',
    '### Diff against HEAD',
    fenced(input.diffStat, '(none)'),
    '',
    '### Recent commits',
    fenced(input.commits, '(none)'),
    '',
    '## Last terminal output',
    fenced(tail(input.output), '(nothing captured)'),
    '',
    '## For the next agent',
    '',
    '- Start by reading the spec and recent commits above, then run `git status` in the directory.',
    '- Uncommitted changes live in the directory above, not in your checkout; read them there if you need them.',
    '- Record what you decide and finish on the task, as the board protocol says.',
    ''
  )
  return lines.join('\n')
}
