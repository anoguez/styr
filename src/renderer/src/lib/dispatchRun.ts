import { createContext } from 'react'
import type { AgentStatus } from '@core/agentState.js'
import type { TerminalSessionInfo } from '@core/types.js'

/** Task ids of the most recent Dispatch run that are still being worked, for the open workspace. */
export const DispatchingContext = createContext<ReadonlySet<string>>(new Set())

/**
 * Which tasks of a Dispatch run are still going. A task is done with the run once its agent is
 * idle or stopped; before the first hook fires there is no status, so a live session of the task
 * keeps it in. Derived each time, never stored: the run is just the ids it started.
 */
export function dispatchingIds(
  runIds: readonly string[],
  agents: ReadonlyMap<string, AgentStatus>,
  sessions: readonly TerminalSessionInfo[],
  workspaceId: string | undefined
): Set<string> {
  const live = new Set(
    sessions
      .filter((s) => s.taskId && !s.replay && (!s.workspaceId || s.workspaceId === workspaceId))
      .map((s) => s.taskId as string)
  )
  const active = new Set<string>()
  for (const id of runIds) {
    const state = agents.get(id)?.state
    if (state ? state !== 'idle' && state !== 'exited' : live.has(id)) active.add(id)
  }
  return active
}
