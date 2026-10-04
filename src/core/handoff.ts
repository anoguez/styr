import type { ActivityEntry, TaskStatus } from './types.js'

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
