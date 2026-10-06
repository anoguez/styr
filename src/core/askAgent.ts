const MAX_TITLE = 80

/** The first non-blank line of a question, clipped, or the fallback when there is no question. */
export function askTitle(question: string, fallback: string): string {
  const line =
    question
      .split('\n')
      .map((part) => part.trim())
      .find(Boolean) ?? fallback
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line
}

export interface ForkSource {
  id: string
  title: string
}

/**
 * The brief for an Ask agent run that continues a copy of a task's chat. The fork already holds the
 * whole conversation, so nothing is attached; the instruction is that this is a question, not work.
 */
export function forkDescription(question: string, source: ForkSource): string {
  return [
    question.trim() || 'Look at where this conversation stands and tell me what is going on.',
    '',
    `Forked from ${source.id}: ${source.title}.`,
    'This continues a copy of that conversation to answer the question above. Answer it; do not ' +
      'change files unless asked to.'
  ].join('\n')
}
