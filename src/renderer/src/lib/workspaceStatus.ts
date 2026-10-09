import type { AgentState } from '@core/agentState.js'
import type {
  WorkspaceAgentActivity,
  WorkspaceBoardSummary,
  WorkspaceInfo,
  WorkspacesActivity
} from '@core/types.js'

export type LiveAgentState = Exclude<AgentState, 'exited'>

/** The switcher's words for each live state. An idle agent ended its turn; it is not finished. */
export const ACTIVITY_LABELS: Record<LiveAgentState, string> = {
  waiting: 'waiting on you',
  working: 'working',
  idle: 'turn ended',
  ready: 'ready'
}

const LIVE_STATES: LiveAgentState[] = ['waiting', 'working', 'idle', 'ready']

export interface BackgroundBadge {
  state: 'waiting' | 'working'
  /** Agents waiting plus tasks ready for review; unset for the working badge, which shows no number. */
  count?: number
  label: string
}

type BadgeSignal = 'waiting' | 'review' | 'working'

function countOf(activity: WorkspaceAgentActivity | undefined, signal: BadgeSignal): number {
  if (!activity) return 0
  return signal === 'review' ? activity.review : activity.counts[signal]
}

function namesWith(
  workspaces: WorkspaceInfo[],
  byWorkspace: Record<string, WorkspaceAgentActivity>,
  signal: BadgeSignal
): { names: string[]; total: number } {
  const hits = workspaces
    .map((workspace) => ({
      name: workspace.name,
      count: countOf(byWorkspace[workspace.id], signal)
    }))
    .filter((hit) => hit.count > 0)
  return {
    names: hits.map((hit) => hit.name),
    total: hits.reduce((sum, hit) => sum + hit.count, 0)
  }
}

/**
 * What the closed switcher shows about the workspaces you are not looking at: a count of what needs
 * you there — waiting agents and tasks ready for review — else a working mark, else nothing. Specs
 * are left out: they have no agent event to hang off, so counting them would mean reading task files
 * on every hook event. The active board is excluded by the id the rollup was computed against, so a
 * switch in flight never counts the new board's agents as elsewhere.
 */
export function backgroundBadge(
  activity: WorkspacesActivity,
  workspaces: WorkspaceInfo[]
): BackgroundBadge | undefined {
  if (workspaces.length < 2) return undefined
  const background = workspaces.filter((workspace) => workspace.id !== activity.activeId)
  const waiting = namesWith(background, activity.byWorkspace, 'waiting')
  const review = namesWith(background, activity.byWorkspace, 'review')
  const working = namesWith(background, activity.byWorkspace, 'working')
  const label = [
    waiting.total > 0
      ? `${waiting.total} ${waiting.total === 1 ? 'agent' : 'agents'} waiting in ${waiting.names.join(', ')}`
      : '',
    review.total > 0 ? `${review.total} ready for review in ${review.names.join(', ')}` : '',
    working.total > 0 ? `${working.total} working in ${working.names.join(', ')}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const needsYou = waiting.total + review.total
  if (needsYou > 0) return { state: 'waiting', count: needsYou, label }
  if (working.total > 0) return { state: 'working', label }
  return undefined
}

export interface ElsewhereNotice {
  /** What the pill beside the switcher says, e.g. "2 need you in Client A". */
  text: string
  /** The full wording for the tooltip and screen readers. */
  label: string
  /** The one workspace that needs you; unset when several do, so the pill opens the menu instead. */
  targetId?: string
}

/**
 * The pill beside the switcher that says another workspace needs you — waiting agents and tasks
 * ready for review. Working agents get no pill: they need nothing from you yet.
 */
export function elsewhereNotice(
  activity: WorkspacesActivity,
  workspaces: WorkspaceInfo[]
): ElsewhereNotice | undefined {
  const badge = backgroundBadge(activity, workspaces)
  if (!badge || badge.state !== 'waiting' || !badge.count) return undefined
  const needing = workspaces.filter((workspace) => {
    if (workspace.id === activity.activeId) return false
    const entry = activity.byWorkspace[workspace.id]
    return countOf(entry, 'waiting') + countOf(entry, 'review') > 0
  })
  const verb = badge.count === 1 ? 'needs' : 'need'
  const [only] = needing
  if (needing.length === 1 && only) {
    return {
      text: `${badge.count} ${verb} you in ${only.name}`,
      label: badge.label,
      targetId: only.id
    }
  }
  return { text: `${badge.count} ${verb} you in ${needing.length} workspaces`, label: badge.label }
}

/** "1 waiting on you · 2 working · 1 turn ended", leaving out stopped agents and zero counts. */
export function agentActivityLabel(activity: WorkspaceAgentActivity | undefined): string {
  if (!activity) return ''
  return LIVE_STATES.filter((state) => activity.counts[state] > 0)
    .map((state) => `${activity.counts[state]} ${ACTIVITY_LABELS[state]}`)
    .join(' · ')
}

export type BoardCountGroup = 'needs' | 'running' | 'next'

export interface BoardCount {
  group: BoardCountGroup
  count: number
  label: string
}

const BOARD_COUNT_LABELS: Record<BoardCountGroup, string> = {
  needs: 'need you',
  running: 'running',
  next: 'up next'
}

/** The non-zero Inbox groups, in Inbox order, worded for the switcher row. */
export function boardCounts(summary: WorkspaceBoardSummary | undefined): BoardCount[] {
  if (!summary) return []
  return (['needs', 'running', 'next'] as const)
    .filter((group) => summary[group] > 0)
    .map((group) => ({
      group,
      count: summary[group],
      label: `${summary[group]} ${BOARD_COUNT_LABELS[group]}`
    }))
}

/** The row tooltip: "1 waiting on you · 2 in review · 1 needs spec · 3 running · 4 up next". */
export function boardSummaryLabel(summary: WorkspaceBoardSummary | undefined): string {
  if (!summary) return ''
  const parts: [number, string][] = [
    [summary.waiting, 'waiting on you'],
    [summary.review, 'in review'],
    [summary.spec, summary.spec === 1 ? 'needs spec' : 'need spec'],
    [summary.running, 'running'],
    [summary.next, 'up next']
  ]
  const shown = parts.filter(([count]) => count > 0).map(([count, text]) => `${count} ${text}`)
  return shown.length > 0 ? shown.join(' · ') : 'Nothing open'
}
