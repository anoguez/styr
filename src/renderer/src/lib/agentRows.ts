import { compareAgentStatus, isAgentArchived, type AgentStatus } from '@core/agentState.js'
import { openTaskCounts } from '@core/boardCounts.js'
import type { Task, TaskStatus, TerminalSessionInfo } from '@core/types.js'
import { findTaskSession } from './terminalSessions.js'

/** One agent as the sidebar, the palette and the status bar list it. */
export interface AgentRow {
  task: Task
  agent?: AgentStatus
  session?: TerminalSessionInfo
}

export function sortAgentRows(rows: AgentRow[]): AgentRow[] {
  return [...rows].sort((a, b) => {
    if (a.agent && b.agent) return compareAgentStatus(a.agent, b.agent)
    return Number(Boolean(b.agent)) - Number(Boolean(a.agent))
  })
}

/**
 * The board's agents: every task with a status or a chat, minus archived and Done ones, joined to
 * its open tab in this workspace. Every agent count derives from these rows.
 */
export function agentRowsFor(
  tasks: Task[],
  shown: ReadonlyMap<string, AgentStatus>,
  sessions: TerminalSessionInfo[],
  workspaceId: string
): AgentRow[] {
  return sortAgentRows(
    tasks
      .filter((task) => (shown.has(task.id) || task.agentSession) && !isAgentArchived(task))
      .map((task) => ({
        task,
        agent: shown.get(task.id),
        session: findTaskSession(sessions, task.id, workspaceId)
      }))
  )
}

/** The status bar's summary: open tasks, the ones needing a spec, and running agents. */
export function boardSummary(board: Record<TaskStatus, Task[]>, rows: AgentRow[]): string {
  const { total, needsSpec } = openTaskCounts(board)
  const working = rows.filter((row) => row.agent?.state === 'working').length
  return `${total} task${total === 1 ? '' : 's'}${
    needsSpec > 0 ? ` · ${needsSpec} need${needsSpec === 1 ? 's' : ''} a spec` : ''
  }${working > 0 ? ` · ${working} running` : ''}`
}
