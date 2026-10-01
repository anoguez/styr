import { useEffect, useMemo, useState } from 'react'
import type { AgentStatus } from '@core/agentState.js'

/**
 * Live agent state keyed by task id. The map identity is stable between updates so callers can use
 * it as an effect dependency without re-running on every render.
 */
export function useAgents(): Map<string, AgentStatus> {
  const [statuses, setStatuses] = useState<AgentStatus[]>([])

  useEffect(() => {
    void window.api.agents.list().then(setStatuses)
    return window.api.agents.onChanged(setStatuses)
  }, [])

  return useMemo(() => new Map(statuses.map((status) => [status.taskId, status])), [statuses])
}
