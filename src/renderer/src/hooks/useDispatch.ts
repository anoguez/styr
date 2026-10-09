import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentStatus } from '@core/agentState.js'
import type { OrchestrationSummary, TerminalSessionInfo } from '@core/types.js'
import { dispatchQueue } from '../lib/boardView.js'
import { dispatchingIds } from '../lib/dispatchRun.js'
import { dispatchButton, isDispatchLive } from '../lib/orchestrateHint.js'
import { useAutoDispatch } from './useAutoDispatch.js'

/**
 * Dispatch for the open workspace: the plan (what would start), the run in progress, Auto-run, and
 * what the header button shows. The plan is refreshed whenever the board, the tabs or the agents
 * change, so it always reflects what is free right now.
 */
export function useDispatch({
  workspaceId,
  board,
  sessions,
  agents,
  adopt
}: {
  workspaceId: string
  /** Any change to the board; only its identity is read, to refresh the plan. */
  board: unknown
  sessions: TerminalSessionInfo[]
  agents: ReadonlyMap<string, AgentStatus>
  adopt: (session: TerminalSessionInfo) => void
}) {
  const [orchestration, setOrchestration] = useState<OrchestrationSummary | null>(null)
  /** Task ids the last Dispatch run started. */
  const [runIds, setRunIds] = useState<string[]>([])
  const auto = useAutoDispatch(workspaceId)
  const { state: autoState, setOn: setAutoOn } = auto

  const refresh = useCallback(() => {
    void window.api.orchestrate.plan().then(setOrchestration)
  }, [])
  useEffect(refresh, [refresh, board, sessions, agents])
  useEffect(() => window.api.orchestrate.onAutoStarted(adopt), [adopt])
  // Task ids repeat across workspaces, so a run belongs to the workspace it started in.
  useEffect(() => setRunIds([]), [workspaceId])

  const run = useCallback(
    async (taskIds: string[]) => {
      const started = await window.api.orchestrate.run(taskIds)
      for (const entry of started) adopt(entry.session)
      setRunIds(started.map((entry) => entry.taskId))
      refresh()
    },
    [adopt, refresh]
  )

  /** Start the listed tasks before switching Auto-run on, so its first pass does not race them. */
  const confirm = useCallback(
    async (summary: OrchestrationSummary, autoOn: boolean) => {
      if (summary.dispatch.length > 0) await run(summary.dispatch.map((entry) => entry.taskId))
      if (autoOn !== autoState.on) setAutoOn(autoOn)
    },
    [run, autoState.on, setAutoOn]
  )

  const dispatching = useMemo(
    () => dispatchingIds(runIds, agents, sessions, workspaceId),
    [runIds, agents, sessions, workspaceId]
  )
  const button = useMemo(
    () => dispatchButton(orchestration, autoState, dispatching.size > 0),
    [orchestration, autoState, dispatching]
  )
  const queued = useMemo(() => dispatchQueue(orchestration), [orchestration])
  const queuedPositions = useMemo(
    () => new Map([...queued].map(([id, entry]) => [id, entry.position])),
    [queued]
  )

  return {
    orchestration,
    dispatching,
    button,
    live: isDispatchLive(button),
    queued,
    queuedPositions,
    auto: autoState,
    setAutoOn,
    confirm
  }
}
