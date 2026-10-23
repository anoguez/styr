import { askTitle } from '@core/askAgent.js'

export type TerminalTaskKind = 'ask' | 'explain' | 'fix' | 'output'

export interface TerminalContext {
  cwd: string
  command?: string
  exitCode?: number
  /** What the user selected, when they did; otherwise the command's output. */
  text: string
  /** What the user typed into the Ask agent prompt. Only the `ask` kind uses it. */
  question?: string
}

const MAX_TITLE = 80
const MAX_TEXT = 6000

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

/** The output as plain text, clipped to its tail; `clipped` says whether the head was dropped. */
function clip(text: string): { text: string; clipped: boolean } {
  const trimmed = text.replace(ANSI, '').trim()
  return trimmed.length > MAX_TEXT
    ? { text: trimmed.slice(-MAX_TEXT), clipped: true }
    : { text: trimmed, clipped: false }
}

/** A fence longer than any run of backticks in the text, so the output cannot close it early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * The repository a task from a terminal should work in: the git root of the directory the command
 * ran in, else the default repository (the draft applies it when this is undefined). Never throws.
 */
export async function repoForDirectory(
  cwd: string,
  gitContext: (path: string) => Promise<{ root: string | null }>
): Promise<string | undefined> {
  try {
    return (await gitContext(cwd)).root ?? undefined
  } catch {
    return undefined
  }
}

function shortTitle(text: string): string {
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1)}…` : text
}

/** The first non-blank line, for the one-line note beside a failure's actions. */
export function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  )
}

/** A task draft (title and description) that hands a terminal's output to an agent. */
export function taskFromTerminal(
  kind: TerminalTaskKind,
  context: TerminalContext
): { title: string; description: string; tags?: string[]; ready?: boolean } {
  const subject = context.command ? `\`${context.command}\`` : 'terminal output'
  const verbs: Record<TerminalTaskKind, string> = {
    fix: `Fix: ${context.command ?? 'terminal failure'}`,
    explain: `Explain: ${context.command ?? 'terminal output'}`,
    ask: askTitle(context.question ?? '', `Ask: ${context.command ?? 'terminal'}`),
    output: `Terminal: ${context.command ?? 'output'}`
  }
  const intro: Record<TerminalTaskKind, string> = {
    fix: `${subject} failed${context.exitCode === undefined ? '' : ` with exit code ${context.exitCode}`}. Find the cause and fix it.`,
    explain: `Explain what ${subject} printed and what, if anything, needs to change.`,
    ask: context.question?.trim() || 'Look at this terminal and tell me what is going on.',
    output: `Output captured from the terminal.`
  }
  const lines = [intro[kind], '', `Directory: \`${context.cwd}\``]
  if (context.command) lines.push(`Command: \`${context.command}\``)
  if (context.exitCode !== undefined) lines.push(`Exit code: ${context.exitCode}`)
  const output = clip(context.text)
  const fence = fenceFor(output.text)
  if (output.clipped) lines.push('', `(output trimmed to the last ${MAX_TEXT} characters)`)
  lines.push('', fence, output.text || '(no output captured)', fence)
  return {
    title: shortTitle(verbs[kind]),
    description: lines.join('\n'),
    ...(kind === 'ask' ? { tags: ['ask'], ready: true } : {}),
    ...(kind === 'fix' ? { ready: true } : {})
  }
}
