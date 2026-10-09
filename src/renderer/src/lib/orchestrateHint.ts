import {
  ORCHESTRATION_LANES,
  type AutoDispatchState,
  type OrchestrationSummary
} from '@core/types.js'

/** The Orchestrate button's tooltip: what a click would start, or why nothing would. */
export function orchestrateHint(orchestration: OrchestrationSummary | null): string {
  if (!orchestration) return 'Dispatch'
  const { dispatch, occupied, capacity, optedOut, missingWorkingDir } = orchestration
  if (dispatch.length > 0) {
    return `Start ${dispatch.length}: ${dispatch.map((d) => `${d.taskId} (${d.lane})`).join(', ')}`
  }
  const full = ORCHESTRATION_LANES.filter(
    (lane) => occupied[lane] >= capacity[lane] && capacity[lane] > 0
  )
  if (full.length > 0) return `No free slots in: ${full.join(', ')}`
  const notes = [
    orchestration.idleSessions > 0
      ? `${orchestration.idleSessions} already have a terminal tab open — close it to hand the task back`
      : '',
    orchestration.blocked > 0 ? `${orchestration.blocked} blocked by other tasks` : '',
    optedOut > 0 ? `${optedOut} opted out` : '',
    missingWorkingDir > 0 ? `${missingWorkingDir} without a working directory` : ''
  ].filter(Boolean)
  return notes.length > 0 ? `Nothing to start — ${notes.join(', ')}` : 'Nothing ready to start'
}

export type DispatchButtonMode = 'idle' | 'dispatching' | 'auto' | 'paused'

/**
 * The one Dispatch button in the header carries Auto-run too: a workspace has at most one Auto-run,
 * so its state is the button's state rather than a second button beside it.
 */
export function dispatchButton(
  orchestration: OrchestrationSummary | null,
  auto: AutoDispatchState,
  dispatching: boolean
): { mode: DispatchButtonMode; label: string; badge: number; title: string } {
  const running = orchestration
    ? ORCHESTRATION_LANES.reduce((sum, lane) => sum + orchestration.occupied[lane], 0)
    : 0
  if (auto.on) {
    return {
      mode: 'auto',
      label: 'Auto-run',
      badge: running,
      title: `Auto-run is on · ${running} running. Click to manage or stop it.`
    }
  }
  if (dispatching)
    return { mode: 'dispatching', label: 'Dispatching', badge: 0, title: 'Dispatch is running' }
  const waiting = orchestration?.dispatch.length ?? 0
  const hint = orchestrateHint(orchestration)
  if (auto.paused) {
    return {
      mode: 'paused',
      label: 'Auto-run paused',
      badge: waiting,
      title: `${auto.paused === 'limit' ? 'Auto-run started too many tasks in an hour' : 'Three launches in a row failed'}. ${hint}`
    }
  }
  return { mode: 'idle', label: 'Dispatch', badge: waiting, title: hint }
}
