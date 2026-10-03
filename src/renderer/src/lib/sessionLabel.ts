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
  taskTitles: ReadonlyMap<string, string>,
  workspaces?: { activeId: string; names: ReadonlyMap<string, string> }
): SessionLabel {
  if (!session.taskId) return { name: session.title, detail: '' }
  // Task ids repeat across workspaces, so the board's titles describe only the active workspace's
  // sessions; another workspace's tab keeps the title it was launched with, and says where it is.
  const foreign = Boolean(workspaces && session.workspaceId !== workspaces.activeId)
  const name = (!foreign && taskTitles.get(session.taskId)) || session.title
  const where = foreign && session.workspaceId ? workspaces?.names.get(session.workspaceId) : ''
  const provider =
    session.provider === 'codex' ? 'Codex' : session.provider === 'claude' ? 'Claude' : ''
  return {
    name,
    detail: [where, session.taskId, provider, session.replay ? 'replay' : '']
      .filter(Boolean)
      .join(' · ')
  }
}
