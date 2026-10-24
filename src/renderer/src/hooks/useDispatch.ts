import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  /** Task ids Dispatch started in this workspace — by hand or by Auto-run. */
  const [runIds, setRunIds] = useState<string[]>([])
  /** A manual run's launches are in flight. */
  const [launching, setLaunching] = useState(false)
  const auto = useAutoDispatch(workspaceId)
  const { state: autoState, setOn: setAutoOn } = auto

  /** The run's tasks still going, as of the last render. */
  const activeRef = useRef<ReadonlySet<string>>(new Set())
  /** Adds started tasks to the run, dropping the ones that have already finished. */
  const addToRun = useCallback((ids: readonly string[]) => {
    setRunIds((previous) => [
      ...new Set([...previous.filter((id) => activeRef.current.has(id)), ...ids])
    ])
  }, [])

  const refresh = useCallback(() => {
    void window.api.orchestrate.plan().then(setOrchestration)
  }, [])
  useEffect(refresh, [refresh, board, sessions, agents])
  useEffect(
    () =>
      window.api.orchestrate.onAutoStarted((session) => {
        adopt(session)
        const { taskId } = session
        if (taskId && (!session.workspaceId || session.workspaceId === workspaceId))
          addToRun([taskId])
      }),
    [adopt, addToRun, workspaceId]
  )
  // Task ids repeat across workspaces, so a run belongs to the workspace it started in.
  useEffect(() => setRunIds([]), [workspaceId])

  const run = useCallback(
    async (taskIds: string[]) => {
      setLaunching(true)
      try {
        const started = await window.api.orchestrate.run(taskIds)
        for (const entry of started) adopt(entry.session)
        addToRun(started.map((entry) => entry.taskId))
      } finally {
        setLaunching(false)
        refresh()
      }
    },
    [adopt, addToRun, refresh]
  )

  /** Start the listed tasks before switching Auto-run on, so its first pass does not race them. */
  const confirm = useCallback(
    async (taskIds: string[], autoOn: boolean) => {
      if (taskIds.length > 0) await run(taskIds)
      if (autoOn !== autoState.on) setAutoOn(autoOn)
    },
    [run, autoState.on, setAutoOn]
  )

  const dispatching = useMemo(
    () => dispatchingIds(runIds, agents, sessions, workspaceId),
    [runIds, agents, sessions, workspaceId]
  )
  useEffect(() => {
    activeRef.current = dispatching
  }, [dispatching])
  const button = useMemo(
    () => dispatchButton(orchestration, autoState, launching),
    [orchestration, autoState, launching]
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
