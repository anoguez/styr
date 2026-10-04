export type TerminalTaskKind = 'ask' | 'explain' | 'fix' | 'output'

export interface TerminalContext {
  cwd: string
  command?: string
  exitCode?: number
  /** What the user selected, when they did; otherwise the command's output. */
  text: string
}

const MAX_TITLE = 80
const MAX_TEXT = 6000

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_TEXT ? `…${trimmed.slice(-MAX_TEXT)}` : trimmed
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
): { title: string; description: string } {
  const subject = context.command ? `\`${context.command}\`` : 'terminal output'
  const verbs: Record<TerminalTaskKind, string> = {
    fix: `Fix: ${context.command ?? 'terminal failure'}`,
    explain: `Explain: ${context.command ?? 'terminal output'}`,
    ask: `Look at ${context.command ?? 'terminal output'}`,
    output: `Terminal: ${context.command ?? 'output'}`
  }
  const intro: Record<TerminalTaskKind, string> = {
    fix: `${subject} failed${context.exitCode === undefined ? '' : ` with exit code ${context.exitCode}`}. Find the cause and fix it.`,
    explain: `Explain what ${subject} printed and what, if anything, needs to change.`,
    ask: `Look at this terminal and tell me what is going on.`,
    output: `Output captured from the terminal.`
  }
  const lines = [intro[kind], '', `Directory: \`${context.cwd}\``]
  if (context.command) lines.push(`Command: \`${context.command}\``)
  if (context.exitCode !== undefined) lines.push(`Exit code: ${context.exitCode}`)
  lines.push('', '```', clip(context.text) || '(no output captured)', '```')
  return { title: shortTitle(verbs[kind]), description: lines.join('\n') }
}
