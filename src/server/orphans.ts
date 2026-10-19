import type { AgentStatus } from '@core/agentState.js'

/**
 * A server that died without stopping (a reboot, a crash, SIGKILL) recorded no terminal exits, so
 * its agents would still read `working` or `waiting` with nothing behind them. At start the server
 * owns no session yet, so every agent not already `exited` is marked exited, as a desktop app
 * restart leaves them, and each resumes from its card (`--resume`). Returns how many it marked.
 */
export function exitOrphanedAgents(ports: {
  workspaceIds(): string[]
  statuses(workspaceId: string): AgentStatus[]
  markExited(taskId: string, workspaceId: string): void
}): number {
  let marked = 0
  for (const workspaceId of ports.workspaceIds()) {
    let statuses: AgentStatus[]
    try {
      statuses = ports.statuses(workspaceId)
    } catch (error) {
      console.error(`Styr server: could not read the agents of ${workspaceId}:`, error)
      continue
    }
    for (const status of statuses) {
      if (status.state === 'exited') continue
      ports.markExited(status.taskId, workspaceId)
      marked++
    }
  }
  return marked
}
