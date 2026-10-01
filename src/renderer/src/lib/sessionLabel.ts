import type { TerminalSessionInfo } from '@core/types.js'

export interface SessionLabel {
  name: string
  detail: string
}

/**
 * How a terminal tab names itself. A task session shows the task's current title, falling back to
 * the title recorded at launch when the task is not on the board (a search can filter it out), with
 * the task id as the secondary detail. Shared by the tab strip and the command palette so the two
 * always agree.
 */
export function sessionLabel(
  session: TerminalSessionInfo,
  taskTitles: ReadonlyMap<string, string>
): SessionLabel {
  if (!session.taskId) return { name: session.title, detail: '' }
  const name = taskTitles.get(session.taskId) ?? session.title
  return { name, detail: session.replay ? `${session.taskId} · replay` : session.taskId }
}
