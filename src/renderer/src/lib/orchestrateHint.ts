import { ORCHESTRATION_LANES, type OrchestrationSummary } from '@core/types.js'

/** The Orchestrate button's tooltip: what a click would start, or why nothing would. */
export function orchestrateHint(orchestration: OrchestrationSummary | null): string {
  if (!orchestration) return 'Orchestrate'
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
    optedOut > 0 ? `${optedOut} opted out` : '',
    missingWorkingDir > 0 ? `${missingWorkingDir} without a working directory` : ''
  ].filter(Boolean)
  return notes.length > 0 ? `Nothing to start — ${notes.join(', ')}` : 'Nothing ready to start'
}
